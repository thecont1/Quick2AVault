import { defineConfig, externalizePackage } from "@glaze/core/build";

// anydoc's napi binding loads a platform-specific .node binary from disk, so it
// can't be bundled — externalize it (and its binary packages) into the build's
// node_modules instead.
const anydoc = externalizePackage("@firecrawl/anydoc");

export default defineConfig({
  build: {
    external: [...anydoc.externals],
    plugins: [anydoc.plugin],
  },
});
