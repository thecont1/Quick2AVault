import assert from "node:assert/strict";

import { trainingControlPresentation } from "./training-control-model.js";

assert.deepEqual(trainingControlPresentation(true), {
  active: true,
  ariaLabel: "Turn Training Mode off",
  title: "Training Mode is on",
});
assert.deepEqual(trainingControlPresentation(false), {
  active: false,
  ariaLabel: "Turn Training Mode on",
  title: "Training Mode is off",
});

console.log("training control model smoke: ok");
