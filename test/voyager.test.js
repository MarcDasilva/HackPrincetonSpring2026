import test from "node:test";
import assert from "node:assert/strict";
import { VoyagerAdapter } from "../src/worker/voyager-adapter.js";

test("fake Voyager returns deterministic task result", async () => {
  const voyager = new VoyagerAdapter({ simulationMode: true });
  const result = await voyager.executeTask({
    objective: "Mine iron",
    kind: "mine_ore",
    target: "iron_ore",
    quantity: 10,
  });
  assert.equal(result.success, true);
  assert.equal(result.inventory_delta.iron_ore, 10);
});
