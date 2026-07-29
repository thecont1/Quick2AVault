import assert from "node:assert/strict";

import { trainingControlPresentation } from "./training-control-model.js";

assert.deepEqual(trainingControlPresentation(true), {
  active: true,
  ariaLabel: "Turn Learning Mode off",
  title: "Learning Mode is on",
});
assert.deepEqual(trainingControlPresentation(false), {
  active: false,
  ariaLabel: "Turn Learning Mode on",
  title: "Learning Mode is off",
});

console.log("training control model smoke: ok");
