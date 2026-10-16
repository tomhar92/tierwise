// Imported for its side effect, and first: policy.ts reads its thresholds from
// the environment when it is imported, so the stored settings have to be in
// place before that happens.
import { applyConfig, ConfigFileError } from "./config.js";

// `tierwise config` must see the environment as the user set it, to report where
// each value comes from, and must still run when the file is broken so it can be
// fixed. Test runs must not pick up the developer's own stored settings.
const skip = process.argv[2] === "config" || process.env.NODE_TEST_CONTEXT !== undefined;

if (!skip) {
  try {
    applyConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigFileError)) throw error;
    console.error(`tierwise: ${error.message}`);
    process.exit(1);
  }
}
