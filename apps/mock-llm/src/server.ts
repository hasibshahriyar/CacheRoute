import { buildMockLlmApp } from './app.js';

const port = Number(process.env.PORT ?? 8081);
const app = buildMockLlmApp();

app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`mock-llm listening on http://0.0.0.0:${port}`);
});
