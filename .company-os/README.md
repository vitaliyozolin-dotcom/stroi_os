# Company OS Core v2

Mandatory path: Source-of-Truth Controller -> AI Contract Gate -> Experiment Operator -> Revenue Recovery Agent -> SOP Compiler.

Every AI process must declare inputs, expected result, allowed and forbidden actions, responsible human, maximum cost per run, benefit metric, automatic shutdown condition, and full user opt-out behavior.

A process without a valid AI contract is blocked from production. Financial actions are blocked when source data is stale, conflicted, or unverified. Money transfers, contract signatures, legal commitments, customer-data deletion, and irreversible external actions require explicit human approval.

New ideas and major changes must run as bounded experiments ending in KILL, ITERATE or SCALE. Revenue Recovery only consumes verified data. Accepted repeatable work is evaluated for conversion into reusable SOPs, checklists, templates, prompts or modules.

Runtime interfaces: `data.verify(metric)`, `aiContract.validate(processId)`, `experiment.evaluate(workItem)`, `revenueRecovery.scan(scope)`, `sopCompiler.capture(acceptedWork)`.
