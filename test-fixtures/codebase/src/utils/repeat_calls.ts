/**
 * Fixture to ensure refs extraction does not silently truncate frequent call refs.
 *
 * The body intentionally contains >20 callsites of the same identifier.
 */

export function veryUsed(input: string): string {
	return input.trim();
}

export function useVeryUsedManyTimes(): string[] {
	const out: string[] = [];
	out.push(veryUsed('a'));
	out.push(veryUsed('b'));
	out.push(veryUsed('c'));
	out.push(veryUsed('d'));
	out.push(veryUsed('e'));
	out.push(veryUsed('f'));
	out.push(veryUsed('g'));
	out.push(veryUsed('h'));
	out.push(veryUsed('i'));
	out.push(veryUsed('j'));
	out.push(veryUsed('k'));
	out.push(veryUsed('l'));
	out.push(veryUsed('m'));
	out.push(veryUsed('n'));
	out.push(veryUsed('o'));
	out.push(veryUsed('p'));
	out.push(veryUsed('q'));
	out.push(veryUsed('r'));
	out.push(veryUsed('s'));
	out.push(veryUsed('t'));
	out.push(veryUsed('u'));
	out.push(veryUsed('v'));
	out.push(veryUsed('w'));
	out.push(veryUsed('x'));
	out.push(veryUsed('y'));
	return out;
}
