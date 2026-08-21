export const requestApi = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init);
