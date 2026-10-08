import { z } from 'zod';
const origin = z
  .string()
  .max(253)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        !url.port &&
        url.hostname.includes('.') &&
        !url.hostname.endsWith('.localhost')
      );
    } catch {
      return false;
    }
  }, 'Enter an HTTPS address without a path, port, or credentials.')
  .transform((value) => new URL(value).origin);
export const tunnelConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('temporary') }).strict(),
  z.object({ mode: z.literal('ngrok-domain'), publicUrl: origin }).strict(),
  z
    .object({
      mode: z.literal('cloudflare-named'),
      publicUrl: origin,
      tunnelId: z.string().uuid(),
      credentialsFile: z
        .string()
        .min(1)
        .max(4096)
        .refine((v) => !v.includes('\0'), 'Invalid credential file path.'),
    })
    .strict(),
]);
export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;
