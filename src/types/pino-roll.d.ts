declare module "pino-roll" {
  import type { Writable } from "node:stream";

  export interface PinoRollOptions {
    file: string;
    size?: string | number;
    frequency?: "daily" | "hourly" | number;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    mkdir?: boolean;
    extension?: string;
    dateFormat?: string;
    symlink?: boolean;
  }

  export default function pinoRoll(opts: PinoRollOptions): Promise<Writable>;
}
