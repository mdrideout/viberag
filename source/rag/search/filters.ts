/**
 * Filter builder for LanceDB WHERE clauses.
 *
 * Converts SearchFilters to LanceDB filter strings.
 */

import type {SearchFilters} from './types.js';

/**
 * Build a LanceDB WHERE clause from search filters.
 *
 * @param filters - Search filters to convert
 * @returns Filter string for LanceDB WHERE clause, or undefined if no filters
 */
export function buildFilterClause(
	filters: SearchFilters | undefined,
): string | undefined {
	if (!filters) return undefined;

	const conditions: string[] = [];

	// Path prefix filter
	if (filters.pathPrefix) {
		const escaped = escapeSqlString(filters.pathPrefix);
		conditions.push(`filepath LIKE '${escaped}%'`);
	}

	// Path contains (ALL must match)
	if (filters.pathContains && filters.pathContains.length > 0) {
		for (const str of filters.pathContains) {
			const escaped = escapeSqlString(str);
			conditions.push(`filepath LIKE '%${escaped}%'`);
		}
	}

	// Path not contains (NONE must match)
	if (filters.pathNotContains && filters.pathNotContains.length > 0) {
		for (const str of filters.pathNotContains) {
			const escaped = escapeSqlString(str);
			conditions.push(`filepath NOT LIKE '%${escaped}%'`);
		}
	}

	// Type filter (chunk type: function, class, method, module)
	if (filters.type && filters.type.length > 0) {
		const types = filters.type.map(t => `'${escapeSqlString(t)}'`).join(', ');
		conditions.push(`type IN (${types})`);
	}

	// Extension filter
	if (filters.extension && filters.extension.length > 0) {
		const extensions = filters.extension
			.map(e => `'${escapeSqlString(e)}'`)
			.join(', ');
		conditions.push(`extension IN (${extensions})`);
	}

	// Is exported filter
	if (filters.isExported !== undefined) {
		conditions.push(`is_exported = ${filters.isExported}`);
	}

	// Decorator contains filter
	if (filters.decoratorContains) {
		const escaped = escapeSqlString(filters.decoratorContains);
		conditions.push(`decorator_names LIKE '%${escaped}%'`);
	}

	// Has docstring filter
	if (filters.hasDocstring !== undefined) {
		if (filters.hasDocstring) {
			conditions.push(`docstring IS NOT NULL AND docstring != ''`);
		} else {
			conditions.push(`(docstring IS NULL OR docstring = '')`);
		}
	}

	if (conditions.length === 0) {
		return undefined;
	}

	return conditions.join(' AND ');
}

/**
 * Build a name match filter for definition mode.
 *
 * @param symbolName - Symbol name to match
 * @param typeFilter - Optional type filter
 * @returns Filter string for LanceDB WHERE clause
 */
export function buildDefinitionFilter(
	symbolName: string,
	typeFilter?: ('function' | 'class' | 'method' | 'module')[],
): string {
	const conditions: string[] = [];

	// Exact name match
	const escaped = escapeSqlString(symbolName);
	conditions.push(`name = '${escaped}'`);

	// Type filter for definitions (exclude module chunks)
	if (typeFilter && typeFilter.length > 0) {
		const types = typeFilter.map(t => `'${escapeSqlString(t)}'`).join(', ');
		conditions.push(`type IN (${types})`);
	} else {
		// Default: look for function, class, method definitions
		conditions.push(`type IN ('function', 'class', 'method')`);
	}

	return conditions.join(' AND ');
}

/**
 * Escape a string for use in SQL LIKE clause.
 */
function escapeSqlString(str: string): string {
	// Escape single quotes by doubling them
	// Also escape % and _ which are LIKE wildcards
	return str
		.replace(/'/g, "''")
		.replace(/%/g, '\\%')
		.replace(/_/g, '\\_');
}
