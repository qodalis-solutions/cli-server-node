/**
 * Collects items from an async paginator into a single array.
 * @param paginator - The async iterable paginator returned by an AWS SDK paginate function.
 * @param extract - A function that extracts the relevant items array from each page.
 * @param maxResults - Optional cap on the total number of items to return.
 * @returns A flat array of all extracted items, truncated to maxResults if specified.
 */
export async function paginateAll<T>(
    paginator: AsyncIterable<T>,
    extract: (page: T) => any[],
    maxResults?: number,
): Promise<any[]> {
    const results: any[] = [];
    for await (const page of paginator) {
        results.push(...extract(page));
        if (maxResults && results.length >= maxResults) {
            return results.slice(0, maxResults);
        }
    }
    return results;
}
