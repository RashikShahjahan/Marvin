import express, { type Express, type Request, type Response } from 'express';

const app: Express = express();
const port = 3000;


app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});