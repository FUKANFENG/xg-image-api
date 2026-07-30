export type PaginationResult<T> = {
  items: T[];
  page: number;
  totalPages: number;
  totalItems: number;
};

export function paginateItems<T>(items: readonly T[], requestedPage: number, pageSize: number): PaginationResult<T> {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const normalizedRequestedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(Math.max(1, normalizedRequestedPage), totalPages);
  const start = (page - 1) * safePageSize;

  return {
    items: items.slice(start, start + safePageSize),
    page,
    totalPages,
    totalItems,
  };
}
