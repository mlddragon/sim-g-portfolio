// Shell parsing shared by the contract tests over deploy/vm scripts.

/** Shell text with comment lines removed and continuation lines joined. */
export const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')
    .replace(/\\\n\s*/gu, ' ');

/**
 * Every container invocation, one complete command each: `docker run`,
 * `docker create` and `docker container run|create`, however spaced, with
 * `job=(docker run ...)` arrays expanded where `${job[@]}` is used.
 */
export function containerInvocations(text: string): string[] {
  let joined = code(text);
  const start = String.raw`docker\s+(?:container\s+)?(?:run|create)\b`;
  const arrays = [
    ...joined.matchAll(
      new RegExp(String.raw`^\s*(\w+)=\((${start}[^)]*)\)`, 'gmu'),
    ),
  ];
  for (const [definition, name = '', command = ''] of arrays) {
    joined = joined.replace(definition, '');
    const expansion = command.replace(/\s+/gu, ' ').trim();
    joined = joined
      .replaceAll(`"\${${name}[@]}"`, expansion)
      .replaceAll(`\${${name}[@]}`, expansion);
  }
  return [...joined.matchAll(new RegExp(`${start}[^\\n|]*`, 'gu'))].map(
    (match) => match[0],
  );
}
