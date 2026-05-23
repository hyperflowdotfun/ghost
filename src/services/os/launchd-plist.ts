import { escapeXml } from "./utils.js";

export interface PlistOptions {
  label: string;
  /** Absolute path to the bun runtime binary. */
  bunPath: string;
  /** Absolute path to the ghost script. */
  execPath: string;
  workingDir: string;
  env: Record<string, string>;
}

const THROTTLE_INTERVAL = 10;

function renderEnvDict(env: Record<string, string>): string {
  const entries = Object.entries(env).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) {
    return "";
  }
  const items = entries
    .map(
      ([key, value]) =>
        `\n      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value.trim())}</string>`,
    )
    .join("");
  return [
    "\n    <key>EnvironmentVariables</key>",
    `\n    <dict>${items}`,
    "\n    </dict>",
  ].join("");
}

/** Build a well-formed macOS LaunchAgent plist XML string. */
export function buildPlist(opts: PlistOptions): string {
  const argsXml = [opts.bunPath, opts.execPath, "daemon"]
    .map((arg) => `\n      <string>${escapeXml(arg)}</string>`)
    .join("");

  const envXml = renderEnvDict(opts.env);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_INTERVAL}</integer>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(opts.workingDir)}</string>${envXml}
  </dict>
</plist>
`;
}
