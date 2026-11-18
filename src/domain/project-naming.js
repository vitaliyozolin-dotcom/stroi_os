const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const folded = value => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
const administrative = /(?:область|обл\.?|район|р-н|округ|поселение|республика|край|россия|российская федерация)/iu;
const street = /^(?:ул(?:ица)?\.?|проспект|пр-т|проезд|пер(?:еулок)?\.?|шоссе|набережная|бульвар|линия)\s/iu;
const plot = /^(?:(?:земельный\s+)?участок|уч\.?|зу|дом|д\.)\s*\d/iu;
const prefix = /^(?:пос[её]лок(?: городского типа)?|деревня|село|город|хутор|станица|пгт\.?|г\.|д\.|п\.|с\.)\s+(.+)$/iu;
const endOfPlace = /\s+(?=(?:улица|ул\.|проезд|проспект|переулок|пер\.|шоссе|земельный участок|участок|уч\.)\s)/iu;
/** Conservative textual extraction: never geocodes or invents a missing settlement. */
export const constructionLocation = address => {
  const parts = clean(address).split(/[,;\n]+/).map(clean).filter(Boolean);
  const explicit = parts.map(part => part.match(prefix)?.[1]).find(value => value && !/^\d/.test(value));
  const embedded = !explicit && clean(address).match(/(?:^|\s)(?:пос[её]лок(?: городского типа)?|деревня|село|город|хутор|станица)\s+([^,;]+)/iu)?.[1];
  const bare = parts.find(part => !administrative.test(part) && !street.test(part) && !plot.test(part) && !/^\d|^к[ао]дастр/iu.test(part));
  const settlement = clean(explicit || embedded || bare).split(endOfPlace)[0].slice(0, 100);
  return { settlement, detail: parts.filter(part => street.test(part) || plot.test(part)).join(', ').slice(0, 100) };
};
/** Display is derived; persisted identity/code/address and existing records stay untouched. */
export const projectDisplayName = (project, peers = []) => {
  if (project?.status === 'workspace') return clean(project.name) || 'Рабочая среда';
  const location = constructionLocation(project?.address);
  const base = location.settlement || 'Место уточняется';
  const colliding = peers.filter(other => other.id !== project.id && folded(constructionLocation(other.address).settlement) === folded(location.settlement));
  if (!colliding.length) return base;
  const detailed = location.detail ? `${base} · ${location.detail}` : base;
  const sameDetail = colliding.some(other => folded(constructionLocation(other.address).detail) === folded(location.detail));
  return sameDetail || !location.detail ? `${detailed} · ${clean(project.code) || clean(project.id)}` : detailed;
};
export const withProjectLocationName = (project, peers = []) => {
  const name = projectDisplayName(project, peers);
  if (name === project.name) return project;
  const nameAliases = [...new Set([...(project.nameAliases ?? []), clean(project.name)].filter(alias => alias && alias !== name))];
  return { ...project, name, nameAliases };
};
