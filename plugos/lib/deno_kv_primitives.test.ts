import { DenoKvPrimitives } from "./deno_kv_primitives.ts";
import { allTests } from "./kv_primitives.test.ts";

Deno.test("Test Deno KV Primitives", async () => {
  const tmpFile = await Deno.makeTempFile();
  const db = new DenoKvPrimitives(tmpFile);
  await db.init();
  await allTests(db);
  db.close();
  await Deno.remove(tmpFile);
});
