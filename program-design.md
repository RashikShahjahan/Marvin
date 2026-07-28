# Marvin Program Design

**Status:** Proposed for the first release  
**Inputs:** [`product.md`](./product.md) and [`architecture.md`](./architecture.md)  
**Scope:** TypeScript/Bun program layout, module boundaries, types, method signatures, call stacks, and control-flow invariants. Service boundaries and persistence contracts remain owned by `architecture.md`.

## Design summary

Marvin is one Bun process with three stateful edges: Discord, one active Pi `AgentSessionRuntime`, and the process lifecycle. The implementation keeps those edges behind narrow adapters and leaves the conversation controller responsible only for orchestration.

The central design choices are:

1. Use `discord.js` v14 for Gateway events and DM sends.
2. Put every Pi SDK call and raw Pi event behind `PiRuntimeBridge`; no other module imports Pi.
3. Let Pi remain the only owner of prompt text after admission. Marvin keeps only Discord correlation IDs alongside Pi's queue, never a second prompt-text queue.
4. Serialize session transitions (`!stop`, `!new`, shutdown), but do not await an entire model run in the controller. Waiting for `session.prompt()` to finish would prevent later DMs from reaching `session.followUp()`.
5. Reduce raw Pi events immediately into small application events. Tool arguments, tool output, prompts, provider errors, and thinking blocks never reach the logger.
6. Serialize outbound Discord chunks per channel and preserve source text at Discord's 2,000-character boundary, including fenced code blocks.
7. Disable discovered Pi extensions, skills, prompt templates, themes, and context files for v1. Marvin supplies one application-owned system prompt and an explicit built-in tool allowlist.

## Dependency and file-tree diff

Runtime dependencies are deliberately limited to:

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.6",
    "discord.js": "^14.26.4"
  }
}
```

The implementation should have this shape:

```diff
 marvin/
-├── index.ts                         # Bun placeholder
-├── package.json                     # Bun scaffold only
+├── index.ts                         # composition root; no business logic
+├── package.json                     # start/test scripts and runtime dependencies
~├── README.md                        # configuration, security, and run instructions
~├── bun.lock                         # dependency lockfile update
+├── src/
+│   ├── config.ts                    # parse and validate environment/filesystem config
+│   ├── domain.ts                    # dependency-free application event/value types
+│   ├── lifecycle.ts                 # startup ordering and bounded signal shutdown
+│   ├── logger.ts                    # metadata-only structured event logger
+│   ├── system-prompt.ts             # builds the application-owned Pi system prompt
+│   ├── conversation/
+│   │   ├── control-command.ts       # exact !stop / !new / !status parser
+│   │   └── conversation-controller.ts # admission, controls, runtime-event orchestration
+│   ├── discord/
+│   │   └── discord-gateway.ts       # discord.js ingress and outbound transport
+│   ├── pi/
+│   │   ├── pi-event-mapper.ts       # pure raw-event classification/text extraction
+│   │   └── pi-runtime-bridge.ts      # AgentSessionRuntime ownership and rebinding
+│   └── presentation/
+│       ├── response-presenter.ts    # ordered chunks, retries, safe mentions
+│       └── split-discord-message.ts # pure 2,000-char/fence-aware splitter
+└── tests/
+    ├── config.test.ts
+    ├── control-command.test.ts
+    ├── discord-gateway.test.ts
+    ├── conversation-controller.test.ts
+    ├── lifecycle.test.ts
+    ├── pi-event-mapper.test.ts
+    ├── pi-runtime-bridge.test.ts
+    ├── response-presenter.test.ts
+    ├── split-discord-message.test.ts
+    └── support/fakes.ts
```

Dependency direction is one-way:

```text
index.ts / lifecycle.ts
  -> ConversationController
       -> PiRuntimeBridge
       -> ResponsePresenter
  -> DiscordGateway

PiRuntimeBridge       -> Pi SDK
DiscordGateway        -> discord.js
ResponsePresenter     -> DiscordOutput port
all application code  -> domain.ts + typed logger
```

`discord.js` types do not cross into the controller, and Pi types do not cross out of `src/pi/`.

## Shared application types

`src/domain.ts` defines the values exchanged between modules. IDs remain opaque strings.

```ts
export interface DiscordCorrelation {
  messageId: string
  channelId: string
}

export interface UserPrompt extends DiscordCorrelation {
  text: string
  receivedAt: Date
}

export type DiscordIngress =
  | { type: 'prompt'; prompt: UserPrompt }
  | { type: 'attachment_only'; correlation: DiscordCorrelation }

export type AgentStatus =
  | { phase: 'idle'; queued: 0 }
  | { phase: 'running'; queued: number }

export type RuntimeEvent =
  | { type: 'agent_started'; sessionId: string }
  | { type: 'queue_changed'; sessionId: string; queued: number }
  | {
      type: 'assistant'
      sessionId: string
      correlation: DiscordCorrelation
      text: string
    }
  | {
      type: 'failed'
      sessionId: string
      correlation: DiscordCorrelation
      errorId: string
    }
  | {
      type: 'tool_state'
      sessionId: string
      toolName: string
      state: 'started' | 'succeeded' | 'failed'
    }
  | { type: 'settled'; sessionId: string }

export interface DiscordOutput {
  send(channelId: string, content: string): Promise<{ messageId: string }>
}

export type RuntimeAbortReason = 'stop' | 'new' | 'shutdown'

export interface RuntimePort {
  readonly sessionId: string
  getStatus(): AgentStatus
  startPrompt(prompt: UserPrompt): Promise<void>
  queueFollowUp(prompt: UserPrompt): Promise<number>
  stop(reason: RuntimeAbortReason): Promise<void>
  newConversation(): Promise<string>
}

export interface PresenterPort {
  present(request: DiscordCorrelation & { text: string }): Promise<void>
  drain(): Promise<void>
}

```

`RuntimeEvent.assistant.text` is sensitive user data intended only for presentation. The logger's type does not accept it.

## Configuration shape

`src/config.ts` exposes one validated value and no module reads `process.env` directly afterward.

```ts
export const DEFAULT_TOOLS = ['read', 'bash', 'grep', 'find', 'ls'] as const
export const DEFAULT_MAX_PENDING = 3

export interface MarvinConfig {
  discordToken: string
  workspace: string             // canonical absolute directory
  sessionDir: string            // canonical dedicated directory
  model?: string                // Pi provider/model[:thinking] selector
  tools: readonly string[]
  maxPending: number
}

export interface LoadConfigOptions {
  defaultSessionDir: string
  env?: Readonly<Record<string, string | undefined>>
}

export async function loadConfig(options: LoadConfigOptions): Promise<MarvinConfig>
```

`loadConfig` performs all environment, filesystem, and syntax checks before Discord login:

- `DISCORD_TOKEN` is present and non-blank;
- `MARVIN_WORKSPACE` is an absolute, existing, readable directory and is canonicalized with `realpath`;
- `MARVIN_SESSION_DIR`, when absent, uses `options.defaultSessionDir` (`<Pi agent dir>/marvin/sessions` from the composition root);
- the session directory is created with mode `0700` when absent, checked for read/write access, and rejected on POSIX when group/other permission bits are present;
- `MARVIN_MAX_PENDING` is an integer from `0` through `100`;
- `MARVIN_TOOLS` is a comma-separated subset of Pi's built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), contains `bash`, and has no duplicates;
- a present but blank `MARVIN_MODEL` is rejected; a non-blank selector is resolved and validated by `PiRuntimeBridge.create` before Discord login.

The Discord token is retained only in `MarvinConfig` and passed to `DiscordGateway.start`. It is never included in an error object or log event.

## System prompt

`src/system-prompt.ts` keeps product behavior separate from Pi runtime construction:

```ts
export function buildMarvinSystemPrompt(): string
```

The prompt identifies Marvin as a personal assistant operating through Discord, asks for concise Discord-compatible Markdown, permits approved tools for user-requested tasks, requires truthful reporting of tool outcomes, and tells the model to ask for clarification before materially ambiguous actions. It does not contain credentials, filesystem paths, queue/control-command behavior, or claims that the workspace is a security sandbox. Pi still supplies tool schemas for the allowlisted tools.

## Metadata-only logging

`src/logger.ts` uses a discriminated union rather than `log(message, arbitraryObject)`. This makes unsafe fields difficult to add accidentally.

```ts
export type AgentLogState =
  | 'started'
  | 'queue_changed'
  | 'retry_started'
  | 'retry_finished'
  | 'settled'

export type OperationName =
  | 'config'
  | 'pi_create'
  | 'prompt'
  | 'follow_up'
  | 'session_stop'
  | 'session_new'
  | 'discord_ingress'
  | 'discord_send'
  | 'shutdown'

export type LogEvent =
  | { type: 'startup_ready'; sessionId: string }
  | { type: 'shutdown'; reason: 'SIGINT' | 'SIGTERM' | 'startup_error' }
  | { type: 'discord_ignored'; reason: 'bot' | 'non_dm' | 'empty' }
  | { type: 'runtime_diagnostics'; info: number; warnings: number; errors: number }
  | { type: 'agent_state'; sessionId: string; state: AgentLogState; queued?: number }
  | {
      type: 'tool_state'
      sessionId: string
      toolName: string
      state: 'started' | 'succeeded' | 'failed'
    }
  | { type: 'operation_failed'; operation: OperationName; errorId: string }
  | {
      type: 'discord_send_failed'
      sourceMessageId?: string
      chunkIndex: number
      attempt: number
      errorId: string
    }

export interface Logger {
  emit(event: LogEvent): void
}

export function createErrorId(): string
export function createJsonLogger(output?: Pick<Console, 'log'>): Logger
```

The logger never accepts an `Error`, error name/message, stack, free-form message, prompt, response body, shell command, tool arguments/result, token, or credential. Catch sites reduce failures to a fixed `OperationName` plus a generated error ID.

## Discord gateway

`src/discord/discord-gateway.ts` owns the `discord.js` `Client` and converts `Message` objects before invoking application code.

```ts
export type DiscordIngressHandler = (event: DiscordIngress) => Promise<void>
export type FatalHandler = (errorId: string) => void

export function toDiscordIngress(message: Message): DiscordIngress | undefined
export function createDiscordMessageOptions(content: string): MessageCreateOptions

export class DiscordGateway implements DiscordOutput {
  constructor(private readonly logger: Logger)

  start(
    token: string,
    onIngress: DiscordIngressHandler,
    onFatal: FatalHandler,
  ): Promise<void>
  stopAccepting(): void
  send(channelId: string, content: string): Promise<{ messageId: string }>
  close(): Promise<void>
}
```

The client is created with:

```ts
new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})
```

`MessageCreate` conversion is intentionally strict:

```text
message.author.bot                         -> ignore
message.channel.type !== ChannelType.DM   -> ignore
trimmed content is empty + attachments    -> attachment_only
trimmed content is empty                  -> ignore
otherwise                                 -> prompt using original content
```

Using `ChannelType.DM` rather than `isDMBased()` excludes group DMs. A text message with attachments processes only its text; attachment data and URLs do not enter Pi.

Every outbound send resolves/fetches the channel by ID, verifies it is a sendable DM, and passes `createDiscordMessageOptions(content)` to `channel.send`. The helper returns:

```ts
{
  content,
  allowedMentions: { parse: [], repliedUser: false },
}
```

The gateway does not retry or split messages; those policies belong to `ResponsePresenter`. The `MessageCreate` listener attaches a terminal catch to each `onIngress` promise so an EventEmitter callback can never create an unhandled rejection; unexpected failures are reduced to the fixed `discord_ingress` operation and trigger the composition root's fatal path. `stopAccepting` detaches the ingress listener without destroying the client so shutdown acknowledgements already in flight may finish.

## Pi event mapper

`src/pi/pi-event-mapper.ts` contains pure narrowing helpers and is the only place that knows Pi assistant-message content shapes.

```ts
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

type MessageEndEvent = Extract<AgentSessionEvent, { type: 'message_end' }>
type AgentEndEvent = Extract<AgentSessionEvent, { type: 'agent_end' }>

export type AssistantClassification =
  | { kind: 'intermediate' }                  // stopReason: toolUse
  | { kind: 'answer'; text: string }          // stop or length
  | { kind: 'failed' }                        // error
  | { kind: 'aborted' }

export function classifyAssistantMessage(
  event: MessageEndEvent,
): AssistantClassification | undefined

export function hasTerminalAgentFailure(event: AgentEndEvent): boolean
```

Text extraction concatenates only `{ type: 'text' }` blocks in source order. Thinking and tool-call blocks are excluded. `toolUse` messages are intermediate and never posted. `stop` and `length` are presentable terminal answers; an empty answer is allowed through so the presenter can provide its standard fallback.

An `error` message is not immediately public because Pi may retry it. `hasTerminalAgentFailure` is consulted only on `agent_end` where `willRetry === false`.

## Pi runtime bridge

`src/pi/pi-runtime-bridge.ts` owns the runtime, active-session subscription, queue correlation metadata, and abort suppression.

```ts
export type RuntimeListener = (event: RuntimeEvent) => void

export class PiRuntimeError extends Error {
  constructor(
    readonly errorId: string,
    readonly operation: 'prompt' | 'follow_up' | 'session_stop' | 'session_new',
  )
}

export class PiRuntimeBridge implements RuntimePort {
  static defaultSessionDir(): string
  static create(config: MarvinConfig, logger: Logger): Promise<PiRuntimeBridge>

  subscribe(listener: RuntimeListener): () => void
  get sessionId(): string
  getStatus(): AgentStatus

  // Resolves after prompt preflight acceptance, not after the model run.
  startPrompt(prompt: UserPrompt): Promise<void>

  // Returns Pi's queue position after admission.
  queueFollowUp(prompt: UserPrompt): Promise<number>

  stop(reason: RuntimeAbortReason): Promise<void>
  newConversation(): Promise<string>
  dispose(): Promise<void>
}
```

`getStatus` reads the current session's `isStreaming` and `pendingMessageCount` directly; `queue_changed` events are observational and are not a second cached source of truth.

### Runtime construction

The bridge follows the Pi runtime factory pattern so `runtime.newSession()` can replace the active session safely:

```text
PiRuntimeBridge.create
  AuthStorage.create()
  ModelRegistry.create(authStorage)
  createRuntime({ cwd, sessionManager, sessionStartEvent })
    services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: buildMarvinSystemPrompt(),
        appendSystemPrompt: [],
      },
    })
    services.settingsManager.applyOverrides({ followUpMode: 'one-at-a-time' })
    resolveConfiguredModel(config.model, modelRegistry)
    result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel,
      tools: config.tools,
    })
    await validateCreatedRuntime(result, services, config)
    return { ...result, services, diagnostics: services.diagnostics }
  SessionManager.continueRecent(workspace, sessionDir)
  runtime = await createAgentSessionRuntime(createRuntime, initialTarget)
  runtime.setRebindSession(bindSession)
  await bindSession(runtime.session)
```

`bindSession(session)` performs three operations in order:

1. unsubscribe the old session listener;
2. `await session.bindExtensions({})` (the extension set is empty, but Pi's runtime lifecycle is still bound correctly);
3. subscribe to the new session and capture its `sessionId` in the callback.

`validateCreatedRuntime` runs inside the reusable factory, so it protects both startup and `!new`. It fails when a runtime diagnostic has type `error`, a configured model selector cannot be resolved, the requested tools are not exactly the active allowlist, no model is selected, or `modelRegistry.getApiKeyAndHeaders(model)` cannot resolve request authentication. It disposes the just-created session before throwing. Diagnostics are logged only as typed severity counts, not raw diagnostic text. `SessionManager.continueRecent` errors propagate; the bridge must not replace an unreadable recent session with a blank one.

### Prompt admission without blocking follow-ups

`AgentSession.prompt()` resolves after the whole run, so `startPrompt` must not expose that promise as the admission boundary.

```text
startPrompt(prompt)
  assert current session is idle
  append prompt.correlation to pendingCorrelations
  call session.prompt(prompt.text, { preflightResult })
  retain completion promise and attach failure handler
  await preflightResult
    false -> remove correlation and reject admission
    true  -> return to controller while completion continues
```

`queueFollowUp` adds only the correlation metadata, awaits `session.followUp(prompt.text)`, and returns `session.pendingMessageCount`. If Pi rejects the follow-up, the matching metadata entry is removed before the error is surfaced.

The bridge keeps:

```ts
private pendingCorrelations: DiscordCorrelation[] = []
private activeCorrelation: DiscordCorrelation | undefined
```

On a Pi user `message_start`, it shifts the oldest correlation into `activeCorrelation`. On a terminal answer or terminal failure, it emits that correlation and clears it. This FIFO contains no prompt text and is not a conversation store; Pi's follow-up queue remains authoritative. Queue clear, reset, and shutdown clear pending correlation IDs at the same time as `session.clearQueue()`.

### Raw Pi event reduction

| Pi event | Bridge behavior |
| --- | --- |
| `agent_start` | Emit `agent_started`; no prompt content. |
| `queue_update` | Emit only `followUp.length`; discard both text arrays immediately. |
| user `message_start` | Advance opaque Discord correlation metadata. |
| `tool_execution_start` | Emit tool name and `started`; discard args. |
| `tool_execution_end` | Emit tool name and success/error flag; discard result. |
| `message_update` | Ignore; Discord receives no token deltas. |
| assistant `message_end` with `toolUse` | Ignore as intermediate. |
| assistant `message_end` with `stop`/`length` | Emit one `assistant` event when an active correlation exists; otherwise log metadata only. |
| assistant `message_end` with `error` | Retain no error text; wait for `agent_end`. |
| assistant `message_end` with `aborted` | Suppress. |
| `agent_end` with `willRetry: true` | Keep the run active and emit no public failure. |
| terminal failed `agent_end` | Generate an error ID and emit one `failed` event when an active correlation exists; otherwise log metadata only. |
| `auto_retry_start/end` | Metadata-only lifecycle log; no public message unless retries end in failure. |
| `agent_settled` | Emit `settled` as the terminal idle boundary for lifecycle logging. |

Every callback captures the bound session ID. Events from a replaced session are ignored if that ID is no longer current.

### Stop, reset, and disposal

```text
stop(reason)
  mark current session as abort-suppressed
  session.clearQueue()           # discard returned text arrays without inspection
  clear pending correlation metadata
  await session.abort()          # resolves after Pi becomes idle
  clear active correlation

newConversation()
  stop('new')
  runtime.newSession()
    createRuntime(... SessionManager for new JSONL ...)
    runtime rebind callback -> bindSession(new session)
  return runtime.session.sessionId

dispose()
  if shutdown stop has not already completed
    stop('shutdown')
  unsubscribe session listener
  await runtime.dispose()
```

Abort suppression prevents an expected `aborted` assistant message from becoming a public failure. A `runtime.newSession()` result with `cancelled: true` is treated as an internal failure even though v1 has no extension capable of cancelling it.

Pi tears down the old session before its runtime factory creates the replacement. Therefore, any throw from `runtime.newSession()` leaves the bridge unusable: the bridge marks itself closed, throws a `PiRuntimeError`, and accepts no later prompts. The controller queues one error response, calls `onFatal(errorId)`, and stays out of `ready`; the composition root then performs bounded shutdown.

## Conversation controller

`src/conversation/conversation-controller.ts` interprets ingress, admits prompts, and maps reduced runtime events to logging and presentation operations.

```ts
export class ConversationController {
  constructor(dependencies: {
    runtime: RuntimePort
    presenter: PresenterPort
    logger: Logger
    maxPending: number
    onFatal: (errorId: string) => void
  })

  handleIngress(event: DiscordIngress): Promise<void>
  handleRuntimeEvent(event: RuntimeEvent): void
  beginShutdown(): void
}
```

`src/conversation/control-command.ts` is pure:

```ts
export type ControlCommand = 'stop' | 'new' | 'status'

export function parseControlCommand(text: string): ControlCommand | undefined
```

It trims and compares case-insensitively, but accepts only the exact three commands. `!stop now`, `!new please`, and ordinary text containing those strings are prompts.

The controller has a small transition state:

```ts
type ControllerPhase = 'ready' | 'stopping' | 'resetting' | 'shutting_down'
```

A short promise-based critical section serializes state inspection plus one Pi admission call. Long stop/reset work sets a transition phase before releasing that critical section. A normal prompt arriving during a transition receives `Conversation is changing; try again in a moment.` rather than being stored by Marvin. Control transitions are serialized with each other. This synchronization is not a second prompt queue.

Prompt behavior is:

```text
attachment_only
  presenter.present({ ...correlation, text: "Text messages only for now." })

prompt while phase != ready
  presenter.present({ ...prompt, text: "Conversation is changing; try again in a moment." })

prompt while Pi idle
  runtime.startPrompt(prompt)     # await acceptance only

prompt while Pi running and queued < maxPending
  position = runtime.queueFollowUp(prompt)
  presenter.present({ ...prompt, text: "Queued (position <position> of <maxPending> maximum)." })

prompt while Pi running and queued >= maxPending
  presenter.present({ ...prompt, text: "Queue is full; try again after the current work finishes." })
```

If initial prompt admission or follow-up queueing fails, the controller sends `I couldn't start that request (error <id>). Try again or send !new.` It never includes Pi's underlying error message.

Control behavior is:

```text
!status
  idle                  -> "idle"
  running, zero queued  -> "running"
  running, N queued     -> "running; N queued"

!stop
  phase = stopping
  await runtime.stop('stop')
  phase = ready
  presenter.present({ ...commandCorrelation, text: "Stopped." })

!new
  phase = resetting
  await runtime.newConversation()
  phase = ready
  presenter.present({ ...commandCorrelation, text: "Started a new conversation." })
```

The controller subscribes once to `PiRuntimeBridge` after all dependencies exist. `handleRuntimeEvent` ignores any session ID other than `runtime.sessionId` and then:

- emits metadata-only lifecycle logs for `agent_started`, `tool_state`, `queue_changed`, and `settled`;
- presents `assistant.text`, using the event correlation's channel;
- presents the standard error text for `failed`;
- never treats `queue_changed` as a source of prompt text.

## Response presenter

`src/presentation/response-presenter.ts` owns user-visible fallback text, per-channel send ordering, and bounded retry. Because it is the only production consumer of the retry clock, the injectable timing seam and its system implementation live in this module rather than a separate file.

```ts
export interface Clock {
  sleep(delayMs: number): Promise<void>
}

const systemClock: Clock = {
  sleep: (delayMs) => Bun.sleep(delayMs),
}

export interface PresentRequest extends DiscordCorrelation {
  text: string
}

export class ResponsePresenter implements PresenterPort {
  constructor(
    private readonly output: DiscordOutput,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
    private readonly attempts = 3,
  )

  present(request: PresentRequest): Promise<void>
  drain(): Promise<void>
}
```

`present` substitutes `I finished, but there was no text response.` when `text` is empty, calls `splitDiscordMessage`, and appends the send operation to a promise tail keyed by channel ID. Each chunk must finish before the next begins. A failed send uses backoff delays of 250 ms and 1,000 ms; after the third failure, it logs the source Discord message ID, chunk index, attempt, and a generated error ID, stops sending later chunks for that response, and resolves the channel tail so later control responses are not permanently blocked.

`drain` waits for existing channel tails during graceful shutdown. There is no replay file or cross-process delivery state.

## Discord message splitting

`src/presentation/split-discord-message.ts` is a pure function:

```ts
export function splitDiscordMessage(
  source: string,
  limit = 2_000,
): string[]
```

Required invariants:

1. every returned chunk has length `<= limit`;
2. after removing only the synthetic boundary fences, the remaining characters reproduce the source exactly and in order;
3. chunks are non-empty unless the input itself is empty;
4. a code fence open at a chunk boundary is synthetically closed at the end of that chunk and reopened at the start of the next;
5. synthetic close/reopen text is included in the 2,000-character budget.

The algorithm is line-aware:

```text
while source remains
  start with any synthetic reopening prefix and subtract it from the budget
  scan source fence state (``` or ~~~, delimiter length, original info string)
  reserve room for a synthetic closing fence when currently inside code
  choose the largest source window that fits the remaining budget
  move the break left, preferring:
    1. paragraph boundary (blank line)
    2. newline
    3. whitespace
    4. hard character boundary
  never hard-split a UTF-16 surrogate pair
  never split through a source fence delimiter when an earlier valid break exists
  if the break is inside a fence:
    append newline + matching closing delimiter
    prefix the next chunk with the original opening fence line + newline
  advance only by consumed source characters, never by synthetic wrappers
```

Fence recognition follows Markdown's useful subset: up to three leading spaces, at least three matching backticks or tildes, and a closing delimiter using the same character with at least the opening length. The opening line, including its language/info suffix, is retained for synthetic reopening. If wrapper overhead leaves no room for one source character, the splitter hard-closes before the boundary and starts a fresh fenced chunk; it must always make progress.

## Call-stack trees

### Startup

```text
index.ts
  main()
    PiRuntimeBridge.defaultSessionDir()
      join(getAgentDir(), 'marvin', 'sessions')
    loadConfig({ env: process.env, defaultSessionDir })
      validate workspace/session directory/tools/limits
    PiRuntimeBridge.create(config, logger)
      create AgentSessionRuntime around continueRecent(...)
      bind active AgentSession
      validate diagnostics/model/auth/tool allowlist
    new DiscordGateway(logger)
    new ResponsePresenter(gateway, logger)
    new ConversationController(...)
    runtime.subscribe(controller.handleRuntimeEvent)
    installSignalHandlers(shutdown)
    gateway.start(token, controller.handleIngress, onFatal)
```

Discord login is last. Any earlier failure disposes the partially created runtime, writes one metadata-only startup event, sets a non-zero exit code, and never connects the bot.

### First prompt and response

```text
Discord MessageCreate
  DiscordGateway.toIngress
    ConversationController.handleIngress(prompt)
      parseControlCommand -> undefined
      runtime.getStatus -> idle
      PiRuntimeBridge.startPrompt(prompt)
        session.prompt(text, preflightResult)
          Pi agent/tool loop
          message_end(toolUse) -> ignored
          message_end(stop)
            classifyAssistantMessage
            RuntimeEvent.assistant
              ConversationController.handleRuntimeEvent
                ResponsePresenter.present
                  splitDiscordMessage
                  send chunks serially with bounded retry
```

### Prompt received while running

```diff
 Discord MessageCreate
   ConversationController.handleIngress(prompt)
-    runtime.getStatus -> idle
-    runtime.startPrompt(prompt)
+    runtime.getStatus -> running; N queued
+    if N == maxPending
+      presenter.present(queue-full message)
+    else
+      runtime.queueFollowUp(prompt)
+        session.followUp(text)
+      presenter.present(queue-position acknowledgement)
```

When Pi later promotes that follow-up, its user `message_start` advances correlation metadata. No controller callback calls `session.prompt()` for queued text.

### Stop and new conversation

```text
handleIngress(!stop)
  phase = stopping
  runtime.stop('stop')
    suppress abort outcome
    session.clearQueue()
    clear correlation metadata
    await session.abort()
  phase = ready
  presenter.present({ ...commandCorrelation, text: "Stopped." })

handleIngress(!new)
  phase = resetting
  runtime.newConversation()
    runtime.stop('new')
    runtime.newSession()
      recreate cwd-bound Pi services/session
      bindSession(new session)
  phase = ready
  presenter.present({ ...commandCorrelation, text: "Started a new conversation." })
```

### Bounded shutdown

```text
SIGINT / SIGTERM
  shutdown(reason)                     # idempotent
    controller.beginShutdown()
    gateway.stopAccepting()
    runtime.stop('shutdown')
    presenter.drain()
    runtime.dispose()
    gateway.close()
  race cleanup against 10-second timeout
  set process.exitCode
```

A second signal during shutdown may terminate immediately. Shutdown errors are reduced to operation name plus error ID; cleanup continues through all remaining steps.

## Concurrency and ownership invariants

- Exactly one `AgentSessionRuntime`, one active bound `AgentSession`, and one Discord client exist.
- Only `PiRuntimeBridge` invokes `prompt`, `followUp`, `clearQueue`, `abort`, `newSession`, or `dispose`.
- The controller never awaits the full prompt completion while holding its admission critical section.
- Pi is the sole owner of queued prompt text. Marvin's correlation FIFO contains IDs only.
- Session replacement occurs only after queue clear and abort settlement.
- A raw Pi callback never awaits Discord network I/O; it emits a reduced application event, and the presenter owns outbound ordering.
- Outbound chunks for one channel never overlap.
- Session subscriptions and signal handlers each have explicit disposal.
- No public response or log contains provider error details, tool arguments/results, thinking content, shell commands, tokens, or credentials.

## Test design

Tests use Bun's test runner and dependency fakes; they do not connect to Discord or a model provider.

| Test file | Required coverage |
| --- | --- |
| `config.test.ts` | missing secrets, canonical workspace, private/default session dir, invalid integers, unknown/duplicate tools, mandatory `bash`, blank model selector |
| `control-command.test.ts` | whitespace/case handling, exact commands, near-misses remain prompts |
| `discord-gateway.test.ts` | bot/non-DM/group-DM/empty filtering, attachment-only mapping, original text preservation, safe outbound options, ingress rejection catch |
| `pi-event-mapper.test.ts` | tool-use suppression, ordered text extraction, thinking exclusion, empty answer, length answer, retryable versus terminal error, aborted result |
| `pi-runtime-bridge.test.ts` | prompt preflight boundary, follow-up position, ID-only correlation order, queue clear, retry failure timing, stale event suppression, session rebind/fatal replacement failure |
| `conversation-controller.test.ts` | idle prompt admission, follow-up admission, queue limit, status text, transition rejection, stop order, reset/rebind behavior, stale-session event rejection, attachment-only response |
| `split-discord-message.test.ts` | 0/1/2,000/2,001 chars, paragraph/newline/space/hard breaks, surrogate pairs, long unbroken text, backtick and tilde fences, long fence info, source fences at boundaries, every chunk within limit, source preservation |
| `response-presenter.test.ts` | empty fallback, sequential chunks, retry delays, stop-after-terminal-chunk-failure, later response not deadlocked |
| `lifecycle.test.ts` | Discord-login-last startup, idempotent shutdown order, drain, timeout, second-signal behavior, partial-startup cleanup |

`tests/support/fakes.ts` provides:

```ts
export class FakeRuntimeBridge { /* controllable status/events/call order */ }
export class FakeDiscordOutput { /* sent messages and injected failures */ }
export class FakeLogger { /* typed LogEvent[] only */ }
export class FakeClock { /* controllable retry delays */ }
```

One local smoke test may instantiate the real Pi bridge with an in-memory/fake provider and a temporary session directory to prove rebinding and correlation ordering, but the unit suite must not depend on the user's Pi credentials or session files.

## Explicit boundaries

- This design follows the accepted architecture decision to trust Discord application visibility as the user boundary. It does not add `MARVIN_USER_ID`; changing back to an explicit user allowlist requires an architecture update first.
- `MARVIN_WORKSPACE` sets Pi's working directory but is not a sandbox. No TypeScript abstraction attempts to enforce filesystem containment over `bash`.
- Attachments, streaming token edits, durable Pi follow-ups, durable Discord outbox/replay, multiple users, multiple DM sessions, guild channels, and arbitrary Pi extensions are out of scope.
- Pi JSONL remains opaque to Marvin. No module parses, patches, mirrors, or indexes session files.
- This is a program-design document, not the vertical-slice implementation plan.

---

This document follows the program-design guidance in [Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md#program-design): align on file layout, types, method signatures, and call stacks before implementation.
