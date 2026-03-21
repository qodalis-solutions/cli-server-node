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
