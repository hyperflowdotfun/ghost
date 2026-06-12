/**
 * `ghost service` subcommand router — register / unregister the OS service.
 */

export interface ServiceCliFlags {
  /** unregister: bypass the interactive confirm. */
  yes?: boolean;
}

export async function runServiceCli(
  subcommand: string | undefined,
  flags: ServiceCliFlags,
): Promise<void> {
  switch (subcommand) {
    case "register": {
      const { runServiceRegisterCli } = await import("./register.js");
      await runServiceRegisterCli();
      return;
    }
    case "unregister": {
      const { runServiceUnregisterCli } = await import("./unregister.js");
      await runServiceUnregisterCli({ yes: flags.yes ?? false });
      return;
    }
    default:
      console.error("usage: ghost service register|unregister");
      process.exit(1);
  }
}
