export interface NamedConstructionProject { id?: string; code?: string; name?: string; address?: string; status?: string; nameAliases?: string[] }
export function constructionLocation(address?: string): { settlement: string; detail: string };
export function projectDisplayName(project: NamedConstructionProject, peers?: NamedConstructionProject[]): string;
export function withProjectLocationName<T extends NamedConstructionProject>(project: T, peers?: NamedConstructionProject[]): T;
