# Архитектурные слои ИКИОМА ОС

Зависимости направляются внутрь:

```text
presentation → application → domain → entities
                         ↓
                        ports
                         ↓
              infrastructure/adapters
```

## Текущий этап

`src/entities` содержит контракты бизнес-сущностей и `AppState`. Слой не зависит от React, HTTP, браузера, хранилищ или runtime-адаптеров.

Публичная точка входа сущностей — `src/entities/index.ts`; её используют core, domain/sync, presentation и тесты. UI-контракт `PageId` принадлежит `src/presentation/navigation.ts`. Совместимый фасад `src/types.ts` удалён после миграции всех потребителей.

Чистый domain-слой содержит финансовые расчёты, task/progress-правила, three-way merge и нормализацию состояния. Публичная точка входа — `src/domain/index.ts`. Форматирование и подписи статусов находятся в `src/presentation`, runtime-генератор идентификаторов — в `src/infrastructure`. Переходные `src/domain.ts`, `src/progressEngine.ts` и `src/conflict.ts` удалены после миграции потребителей.

Application-контракты находятся в `src/application`: `StateChange` передаёт состояние и audit-метаданные, а порты описывают project repository, cache, session, files, clock и ID generator без runtime-зависимостей. `useProjectState` сохраняет `action` и `summary` вместе с expected revision.
Бизнес-страницы сохраняют изменения только через StateChange: Tasks и Quality используют отдельные domain-операции, остальные разделы проходят через application dispatcher с явными action/summary и сохранением существующих payload.

Чистые переходы синхронизации находятся в src/application/project-sync.ts: локальные изменения, hydration, успешное сохранение и revision conflict обрабатываются без React и browser API. HTTP/DTO реализация перенесена в `src/infrastructure/project-http.ts`; переходный `src/storage.ts` удалён после миграции потребителей. Worker делегирует API dispatch, чтение и revision-aware запись проектов, owner-only access projection, HTTP-управление и агрегированный статус интеграций, Telegram link/unlink и setup bootstrap, боевые автоматизации, feedback, защищённый inbox и публичный ingress заявок, а также планирование и доставку уведомлений отдельным boundary-модулям; Telegram list/CAS persistence изолирован в project-store adapter.

## Правила миграции

- Один PR переносит одну архитектурную границу без изменения поведения.
- Сначала добавляется новый публичный контракт, затем переводятся потребители, после чего удаляется совместимый фасад.
- `AppState`, `schemaVersion`, HTTP DTO, expected revision, ролевые проекции и аудит не меняются одновременно с переносом кода.
- Новые зависимости не должны указывать из внутреннего слоя во внешний.
