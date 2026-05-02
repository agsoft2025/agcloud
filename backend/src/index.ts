import app from "./app.js";

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen({ port }).then(() => {
  console.log(`Backend listening on http://localhost:${port}`);
});
