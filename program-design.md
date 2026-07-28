# Marvin Program Design

**Status:** Proposed for the first release  
**Inputs:** [`product.md`](./product.md) and [`architecture.md`](./architecture.md)  
**Scope:** TypeScript/Bun modules, application-facing interfaces, control flow, and tests.

## Design summary

Marvin is one Bun process with two external adapters: Discord and Pi. A small application object connects them, and `index.ts` starts them directly.

The design deliberately uses the product's strongest simplifying invariant: every accepted prompt and every response belongs to one private Discord user. There is one output destination, so Marvin does not carry Discord correlation objects through the Pi runtime or maintain per-channel output state.

The central decisions are:

1. Pin the Pi and Discord dependencies exactly and verify Pi's runtime contract with an integration test before relying on version-specific APIs.
2. Keep all Pi imports and raw Pi events in one module.
3. Expose one atomic `admit()` operation that starts work only while Pi is idle and reports busy otherwise.
4. Do not buffer prompts; text received while Pi is running is neither forwarded nor retained.
5. Send Discord responses immediately, without ordering concurrent sends.
6. Terminate the process directly after a fatal runtime or transport failure.
7. Use small structural dependency types and injected functions for tests rather than a global domain module or general port hierarchy.

## Dependencies

Runtime dependencies are pinned because the design depends on concrete SDK event behavior:

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.82.1",
    "discord.js": "14.26.4"
  }
}
```

An upgrade is a deliberate change that must pass the Pi contract suite. The Bun lockfile remains committed.

## File layout

```text
marvin/
├── index.ts                    # composition root only
├── src/
│   ├── config.ts               # environment and filesystem validation
│   ├── discord.ts              # Discord ingress and direct output
│   ├── marvin.ts               # user-visible orchestration
│   ├── pi.ts                   # all Pi construction, admission, state, and events
│   └── split-message.ts        # pure Discord-size splitter
└── tests/
    ├── config.test.ts
    ├── discord.test.ts
    ├── marvin.test.ts
    ├── pi.test.ts
    ├── pi-contract.test.ts
    ├── split-message.test.ts
    └── support.ts
```

Small types live with the module that owns them. The system prompt is a constant in `pi.ts` until its size or independent evolution justifies a separate file.

Dependency direction is straightforward:

```text
index.ts -> config, discord, marvin, pi
marvin.ts -> structural Pi and send dependencies
discord.ts -> discord.js, split-message
pi.ts -> Pi SDK, config
```

No module other than `discord.ts` imports `discord.js`, and no module other than `pi.ts` imports the Pi SDK.

## Configuration

`src/config.ts` is the only module that reads environment variables.

```ts
export const APPROVED_TOOLS = ['read', 'bash', 'grep', 'find', 'ls'] as const

export interface MarvinConfig {
  discordToken: string
  workspace: string
  sessionDir: string
  model?: string
}

export async function loadConfig(options: {
  env?: Readonly<Record<string, string | undefined>>
  defaultSessionDir: string
}): Promise<MarvinConfig>
```

`loadConfig` performs these checks before Discord login:

- `DISCORD_TOKEN` is present and non-blank;
- `MARVIN_WORKSPACE` is absolute, resolves through `realpath`, is a directory, and is readable/searchable;
- `MARVIN_SESSION_DIR` defaults to a Marvin-specific Pi directory, is created with mode `0700` when absent, resolves through `realpath`, and is readable/writable/searchable;
- the session directory has no group or other permission bits on POSIX; and
- a present `MARVIN_MODEL` is non-blank.

The Pi module performs model, authentication, effective-tool, settings, and resource validation because it owns the SDK objects needed for those checks. There is no `MARVIN_USER_ID` or `MARVIN_TOOLS` setting.

## Discord transport

`src/discord.ts` owns the Discord client, ingress conversion, and accepted DM channel.

```ts
export type DiscordIngress =
  | { type: 'prompt'; text: string }
  | { type: 'attachment_only' }

export type IngressHandler = (event: DiscordIngress) => Promise<void>

export class DiscordTransport {
  constructor(clientFactory?: DiscordClientFactory)

  start(
    token: string,
    onIngress: IngressHandler,
    onFatal: () => void,
  ): Promise<void>

  send(text: string): Promise<void>
}
```

The optional client factory is an internal test seam, not an application port.

The client requests only the direct-message gateway behavior needed by the private application. For the pinned discord.js version, the intended construction is:

```ts
new Client({
  intents: [GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
})
```

Direct-message content availability without the privileged `MessageContent` intent must be confirmed by a local Discord smoke test. The intent is added only if that test demonstrates it is required.

Ingress conversion is strict:

```text
message.author.bot                       -> ignore
message.channel.type !== ChannelType.DM -> ignore
trimmed content empty + attachments      -> attachment_only
trimmed content empty                    -> ignore
otherwise                                -> prompt with original content
```

No author-ID check is performed. Private application visibility is the authorization boundary defined by the product and architecture.

The `MessageCreate` listener attaches a terminal catch to every ingress promise. The Discord client also has an `error` listener, so an EventEmitter rejection or error cannot become an unhandled process failure.

On the first accepted event, the transport records its one-to-one DM as the sole output destination. Every send uses:

```ts
{
  content,
  allowedMentions: { parse: [], repliedUser: false },
}
```

`send(text)` immediately:

1. calls `splitMessage(text)`;
2. sends each chunk sequentially;
3. stops that logical response after a terminal send failure.

Separate calls to `send()` are not coordinated and may interleave. There is no application retry clock. discord.js handles rate limits; ambiguous transport retries could duplicate a chunk. Delivery remains best effort after a send failure.

## Message splitting

`src/split-message.ts` exports one pure function:

```ts
export function splitMessage(source: string, limit = 2_000): string[]
```

Its invariants are:

1. a `limit` that is not a safe integer of at least `2` throws `RangeError` because a UTF-16 surrogate pair needs two code units;
2. empty input returns `[]`;
3. every returned chunk is non-empty and at most `limit` UTF-16 code units;
4. `chunks.join('') === source`;
5. break selection prefers paragraph, newline, whitespace, then a hard boundary;
6. a hard boundary never divides a UTF-16 surrogate pair; and
7. the algorithm always consumes at least one source character.

Empty final assistant text is replaced before splitting with `I finished, but there was no text response.` Markdown fence reconstruction is deliberately omitted because it conflicts with bounded output for pathological fence lines and is not required to preserve source text.

## Pi assistant

`src/pi.ts` owns every Pi SDK object, the active session subscription, admission state, failure handling, and raw event reduction.

### Application-facing API

```ts
export type Admission =
  | { kind: 'started' }
  | { kind: 'busy' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; fatal: boolean }

export type AssistantOutcome =
  | { type: 'answer'; text: string }
  | { type: 'failure'; reason: 'request_failed' }
  | { type: 'fatal'; reason: 'runtime_failed' }

export class PiAssistant {
  static defaultSessionDir(): string
  static create(config: MarvinConfig): Promise<PiAssistant>

  subscribe(listener: (outcome: AssistantOutcome) => void): () => void
  admit(text: string): Promise<Admission>
}
```

The application never sees session IDs, raw Pi events, model objects, tool state, or other SDK state.

### Construction

`PiAssistant.create`:

1. creates Pi authentication, model, settings, and resource services for the validated workspace;
2. disables extensions, skills, prompt templates, themes, context files, and package-provided executable resources;
3. applies an application-owned system prompt;
4. selects only `APPROVED_TOOLS` and verifies the effective tool set;
5. resolves an exact configured model or Pi's valid default model;
6. verifies model authentication without exposing credential details;
7. continues the most recent usable session through Pi's session APIs; and
8. binds one event listener to the active session.

Pi settings that can alter shell execution or load packages must not be inherited unchecked. The exact pinned SDK calls required to sanitize those settings and resources are established by `pi-contract.test.ts`, not duplicated as an architectural dependency throughout the application.

The application system prompt identifies Marvin as a concise Discord assistant, permits approved tools for user-requested work, requires truthful tool reporting, and asks for clarification before materially ambiguous actions. It contains no credentials or claims that the workspace is a sandbox. Pi may add provider-visible runtime context such as the current working directory.

### Atomic admission

`admit()` checks state and sets its active-run marker before its first await:

```text
permanently closed
  -> unavailable

session streaming
  -> busy without calling a Pi prompt API or retaining text

session idle
  -> start prompt
  -> attach completion failure handling immediately
  -> await only Pi's prompt-preflight acceptance boundary
  -> started or failed
```

Later Discord events observe the active-run marker and receive `busy` promptly.

Expected Pi preflight rejections are reduced to `{ kind: 'failed', fatal }`; they do not escape to the Discord listener's terminal catch. Rejected prompt text is not retained. `fatal` is true only when the Pi assistant can no longer admit work safely, in which case it marks itself permanently closed before returning.

Pi remains the only owner of prompt text after admission. Because every answer goes to the same private DM and only one prompt can run, Marvin keeps no pending prompt text, message IDs, or channel IDs. Discord responses are sent directly and may complete in any order.

The completion promise from an initial `prompt()` always has a rejection handler attached before admission returns. A late rejection becomes exactly one safe failure outcome unless the assistant is permanently closed.

### Event reduction

Raw Pi events are handled entirely in `pi.ts`:

| Pi event | Behavior |
| --- | --- |
| Agent start | Ignore. |
| Agent settled | Resolve the active run and emit a failure if it produced no terminal outcome. |
| Message update | Ignore token deltas. |
| Assistant message containing a tool-call block | Treat as intermediate, regardless of stop reason. |
| Assistant `error` result | Wait for Pi's terminal retry decision. |
| Assistant `aborted` result | Ignore. |
| Terminal assistant message without tool calls | Concatenate text blocks in source order and emit one answer. |
| Terminal agent failure after retries | Emit one safe failure. |
| Tool events | Do not forward arguments, results, or commands. |

Thinking and non-text content are never included in Discord output. After a terminal request failure, Pi settlement returns the assistant to `idle`; until then, admission remains `busy`. Application listener failures are caught so they cannot reject back into Pi's event pipeline.

### Failure handling

```text
terminal failure
  emit one safe failure outcome
  allow new admission after Pi settles

fatal runtime failure
  mark permanently closed
  emit one fatal outcome

```

## Marvin application

`src/marvin.ts` contains no Discord or Pi SDK imports. Its dependencies are structural and small:

```ts
interface AssistantDependency {
  admit(text: string): Promise<Admission>
}

type Send = (text: string) => Promise<void>
type FatalHandler = () => void

export class Marvin {
  constructor(
    assistant: AssistantDependency,
    send: Send,
    onFatal: FatalHandler,
  )
  handle(event: DiscordIngress): Promise<void>
  handleOutcome(outcome: AssistantOutcome): void
}
```

Marvin does not parse user-facing commands. Every accepted text DM, including text beginning with `!`, is passed unchanged to `admit()`.

Prompt behavior is:

```text
attachment only -> Text messages only for now.
started         -> no acknowledgement
busy            -> Marvin is already working; try again after it finishes.
unavailable     -> Marvin is temporarily unavailable; try again in a moment.
failed          -> report not accepted; suggest retry only when nonfatal; otherwise call onFatal
```

An answer is sent verbatim unless empty, in which case the standard fallback is used. A nonfatal admission failure says that the request was not accepted and can be retried. A fatal admission failure says Marvin must restart and invokes `onFatal()`. A terminal request failure suggests retrying. A fatal outcome sends a safe response if possible and invokes `onFatal()`.

`handleOutcome` never awaits Discord from inside a Pi callback. It starts the send directly and attaches a terminal catch to the returned promise.

## Composition

`index.ts` is a direct composition root:

```ts
load configuration
create Pi assistant
create Discord transport and Marvin
subscribe Marvin to Pi outcomes
start Discord
```

Invalid startup state rejects the top-level await. Fatal callbacks call `process.exit(1)`. No signal handlers or graceful shutdown path are installed.

## Required Pi contract checks

`tests/pi-contract.test.ts` is mandatory and uses a temporary session directory plus a fake/local provider without user credentials or external network access. It verifies the assumptions most likely to change between SDK versions:

- Bun can import and construct the exactly pinned Pi version;
- prompt preflight resolves before the complete model run;
- session streaming state is observable after prompt acceptance and until settlement;
- preflight rejections become admission failures without retaining prompt text;
- admission while streaming returns busy without forwarding or retaining prompt text;
- `length` responses containing tool calls continue rather than becoming final output;
- terminal answer, retry, and failure event sequences match the reducer;
- continuing the most recent usable session follows Pi's persistence behavior; and
- effective settings, resources, packages, model, authentication, and tools match application policy.

If these checks cannot be implemented against `0.82.1`, dependency selection and this document must be updated before application code proceeds.

## Test design

Tests use Bun's test runner and injected factories/functions. They do not connect to Discord or a paid model provider.

| Test | Primary coverage |
| --- | --- |
| `config.test.ts` | Missing values, canonical directories, permissions, optional model. |
| `discord.test.ts` | Bot/non-DM/group filtering, attachment-only input, original text, safe mentions, direct concurrent sends, send failures, listener catches. |
| `split-message.test.ts` | Invalid limits, empty and boundary lengths, preferred breaks, long unbroken text, surrogate pairs, length and source-preservation properties. |
| `marvin.test.ts` | All text forwarded unchanged, silent start, busy/unavailable/failure results, and fatal outcomes. |
| `pi.test.ts` | Admission, busy rejection without text retention, preflight rejection mapping, event reduction, and failure handling. |
| `pi-contract.test.ts` | Real pinned-SDK behavior listed above. |

`tests/support.ts` contains only shared fakes that are used by more than one test file.
