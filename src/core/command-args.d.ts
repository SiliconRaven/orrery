// Types for command-args.js, so the Hub's TypeScript can import the rules the page also loads.
export interface ArgumentParam {
  name: string; type: string; label: string; required?: boolean;
  default?: string | number | boolean; options?: string[]; min?: number; max?: number;
}
export const MAX_TEXT_ARGUMENT: number;
export const MAX_DURATION_SECONDS: number;
export function paramBounds(param: Pick<ArgumentParam, 'type' | 'min' | 'max'>): { min: number; max: number };
export function parseDuration(value: unknown): number | null;
export function invalidArgument(param: ArgumentParam): string;
export function missingArgument(param: ArgumentParam): string;
export function checkArgument(param: ArgumentParam, value: unknown, members: ReadonlySet<string>): string | number | boolean | undefined;
