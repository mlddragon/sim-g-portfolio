import { z } from 'zod';

/**
 * Transport shape for opaque gateway identifiers: printable ASCII without
 * spaces, at most 512 characters. Stricter than the domain constructors.
 */
export const opaqueIdentifier = z.string().regex(/^[\x21-\x7e]{1,512}$/u);
