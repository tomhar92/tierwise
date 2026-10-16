import {
  configPath,
  maskSecret,
  readConfig,
  SETTINGS,
  validateSetting,
  writeConfig,
  ConfigFileError,
} from "../src/config.js";

export const CONFIG_USAGE = `Usage: tierwise config <command>
  set <KEY> <value>   store a setting (persists across shells)
  unset <KEY>         remove a stored setting
  get <KEY>           print the effective value
  list                show every setting, its value and where it comes from
  path                print the config file location
An environment variable always overrides the stored value.`;

function show(key: string, value: string): string {
  return SETTINGS[key].kind === "secret" ? maskSecret(value) : value;
}

export function configMain(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [command, key, ...rest] = argv;
  const path = configPath(env);
  try {
    if (command === "path") {
      console.log(path);
      return 0;
    }
    if (command === "list") {
      const stored = readConfig(path);
      for (const name of Object.keys(SETTINGS)) {
        const fromEnv = env[name]?.trim();
        const [value, source] = fromEnv ? [fromEnv, "env"] : name in stored ? [stored[name], "file"] : [undefined, "default"];
        console.log(`${name.padEnd(32)} ${(value === undefined ? "-" : show(name, value)).padEnd(24)} ${source}`);
      }
      return 0;
    }
    if ((command === "get" || command === "set" || command === "unset") && key) {
      if (!(key in SETTINGS)) {
        console.error(validateSetting(key, "x"));
        return 1;
      }
      const stored = readConfig(path);
      if (command === "get") {
        const value = env[key]?.trim() || stored[key];
        if (value === undefined) return 1;
        console.log(value);
        return 0;
      }
      if (command === "unset") {
        delete stored[key];
        writeConfig(path, stored);
        return 0;
      }
      const value = rest.join(" ");
      const problem = validateSetting(key, value);
      if (problem) {
        console.error(problem);
        return 1;
      }
      writeConfig(path, { ...stored, [key]: value.trim() });
      console.log(`${key} saved to ${path}`);
      if (env[key]?.trim()) console.log(`note: ${key} is also set in the environment, which takes precedence`);
      return 0;
    }
  } catch (error) {
    if (!(error instanceof ConfigFileError)) throw error;
    console.error(error.message);
    return 1;
  }
  console.error(CONFIG_USAGE);
  return 1;
}
