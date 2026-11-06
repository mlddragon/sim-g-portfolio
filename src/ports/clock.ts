/** Injectable time source for policy windows and deterministic tests. */
export interface Clock {
  now(): Date;
}
