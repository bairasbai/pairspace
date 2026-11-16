# Recovery checkpoint и актуальный индекс приёмки, 16 ноября 2026

Этот индекс описывает текущее состояние сохранённой локальной истории. Он имеет
приоритет над историческими WIP/pending абзацами старых stage-документов для вопроса
«что принято сейчас». Исторические результаты и ограничения не переписываются.
Это docs-only reliability checkpoint: продуктовый код, SQL, UI и зависимости не меняются.

## Последний принятый код и документы
- Code: `ad06def79ff22115476308ca982be278143a5af4`.
- Code tree: `0bb5915769ad085a48434541ba41485551630723`.
- Предшествующий accepted docs checkpoint: `2f7aafcd56fa2226147b0d52ea9e8b494c66472d`.
- Его tree: `cad51b51d66c2a84f2e0c05749a898d62972fbdf`.
- Новый recovery-docs commit идентифицируется внешним packaging manifest после freeze;
  включать собственный SHA внутрь себя нельзя. Он не означает новую runtime-приёмку.

## Восстановленная основа и удалённая история
Локальная история начинается с восстановленного из Library checkpoint:
`f390e8b3d9f6d5f036e4ecb479db37cb66c97838`, tree
`af85b566cc96d3d18fdcaea1686cd5eba5501fc6`.
Это source-tree эквивалент сохранённого remote
`fdaa9c59da6836351222f2de553ca22056742649`, а не тот же Git commit/history.
Содержимое восстановлено, исходная удалённая ancestry этим не реконструирована.
Потерянный historical prediction commit `985e2bb` НЕ восстановлен и не объявляется
восстановленным ни этим индексом, ни будущим bundle.

Последнее ранее проверенное опубликованное capsule domain состояние:
- Remote code `d5fdc14fe0e88dc73a7055f05c17a643f42c25c6`, tree
  `f6fe76ae23c876770bdc315c7bbda84c97bdc3ae`.
- Local tested code `b951a5e5aff84dfc9d291e1141242db9aa08cf19` имеет тот же tree.
- Remote domain docs `51c8eb2a0b44533f24e10be29c505c38e525f38f`, tree
  `00e7fe39e91f5313e32274b507712659be3b6672`.
- Local docs `ee703f8c1fe07668e40d5095a0d382207b136b3f` имеет тот же tree.
Это mapping ранее выполненной remote-проверки, не новая GitHub-проверка текущего дня.
Remote объекты могут отсутствовать в восстановленном локальном object database;
отсутствие remote SHA в bundle не означает отсутствие эквивалентных source bytes.
Capsule API/mobile, Dispute domain/API/mobile и strict-enum fix ниже НЕ опубликованы
в GitHub в рамках этой работы: запись ждёт отдельного разрешения владельца.
Main/production/компьютер владельца не менялись.

## Индекс принятых bounded stages
Для каждого этапа code SHA означает exact проверенный source; docs SHA содержит
последующее описание результатов, а не повторный FULL на документационном commit.

### Capsule domain
Code `b951a5e5aff84dfc9d291e1141242db9aa08cf19`.
Tree `f6fe76ae23c876770bdc315c7bbda84c97bdc3ae`.
Docs `ee703f8c1fe07668e40d5095a0d382207b136b3f`.
[Контракт и evidence](CAPSULE_POLICY_2026_11_16.md): оба FULL11/11,
API627/mobile2789/PG434. Pure domain, не SQL/API/UI на этом этапе.

### Capsule API
Code `f81097cc587578f3211f77f8307be551f87bce40`.
Tree `1bfc9f6935ad7928429f3ecae066ea5559d59787`.
Docs `326c3e84a7b12bc036e524b8d3d415bbaeee7662`.
[Storage/API evidence](CAPSULE_API_2026_11_16.md): оба FULL11/11,
API642/mobile2808/PG450. Migration044, default-off loopback synthetic API.

### Capsule mobile
Code `1e92e3a639f0f2d5dd6baed53a76ed0a42823411`.
Tree `fe64346769adc88d66f895ec23d9647c460c7d49`.
Docs `55d56070c3f2c9afe420970cec9c2b11cdfa4747`.
[Client/harness evidence](CAPSULE_MOBILE_2026_11_16.md): оба FULL11/11,
API642/mobile2862/PG451. Submitted draft hidden before request, lifecycle scrub.

### Dispute domain
Code `67a606d902a71a9167adefc3238146617bec204f`.
Tree `4435070102ca4d3d38e4ae2d0504973e0062ed30`.
Docs `fb9dceada2de2383b886fb47d4b209cf09c3392e`.
[Domain evidence](DISPUTE_POLICY_2026_11_16.md): оба FULL11/11,
API789/mobile3009/PG451. Добровольное участие, без финансовой механики.
Позже найденный inherited contentState coercion дефект устранён в Dispute API;
историческая приёмка не означала отсутствия malformed-input дефектов.

### Dispute API
Code `8985a87870984178b877a2fb13fb3558a8020b9c`.
Tree `d9ced1a6ebce4e26027124a0962493cddd21efed`.
Docs `da8fd2bd94fc104c897442225ce3452d3449062f`.
[Storage/API evidence](DISPUTE_API_2026_11_16.md): оба FULL11/11,
API872/mobile3028/PG468. Migration045, metadata-only ACK/replay, отдельный reader;
inherited domain enum defect исправлен, не наблюдавшаяся HTTP утечка.

### Strict enum validation
Code `22ceb7a8c554c4a6dc9058b8b6ef4daa165a9bfa`.
Tree `97a2f5fc9e6bbe8a1e22df1f4f38bbf8bd65f926`.
Docs `3c78ad66fd5b5246544c7e2d9f9949d9ec210e72`.
[Fix evidence](ENUM_VALIDATION_2026_11_16.md): оба FULL11/11,
API880/mobile3036/PG468. Stories/Doings/Hard primitive enums; все6 исходных repro
отвергнуты. Старые «known next-stage» passages исторические; эти defects закрыты.

### Dispute mobile
Code `ad06def79ff22115476308ca982be278143a5af4`.
Tree `0bb5915769ad085a48434541ba41485551630723`.
Docs `2f7aafcd56fa2226147b0d52ea9e8b494c66472d`.
[Client/harness evidence](DISPUTE_MOBILE_2026_11_16.md): оба FULL11/11,
API880/mobile3093/PG469. Explicit current reader перед join/resolve, исправлен
read→join list-completeness разрыв; canonical retry и privacy lifecycle scrub.
Author report `/tmp/pairspace-verification-E2IVRI/report.json`, independent
`/tmp/pairspace-verification-zIktm8/report.json`: sourceValid=true, clean exact tree.
Coverage S/B/F/L: API98.64/97.58/99.78/99.48%; mobile95.75/95.42/96.26/97.48%.

## Source archive, bundle и проверка восстановления
Source-only архив сохраняет файлы выбранного tree, но не Git objects, ancestry,
refs или signatures. SHA256 архива доказывает его bytes, не полноту Git history.
Git bundle сохраняет выбранные Git refs и достижимые objects; он не включает
untracked files, node_modules, ignored outputs, локальные reports или внешние secrets.
Bundle с восстановленной local root не превращается в исходную remote history.
Нужны оба формата: source для простого чтения и bundle для точного восстановления.

Packaging выполняется отдельно после этого docs freeze. На момент написания этого
первой версии индекса bundle ещё не был создан. Этот исторический план выполнен
для904f965, см. результаты ниже; новая финальная docs-версия требует пересборки bundle
и отдельной integrity-проверки, которые пока не объявляются выполненными. Внешний manifest должен фиксировать bundle
hash, included refs, root/latest SHAs/trees, scope и отдельно report artifacts.
Independent restore должен проверить bundle verify/list-heads, отсутствие неполных
prerequisites для заявленного standalone recovery, clone в пустую offline-копию,
exact refs/trees/history и tracked file modes/bytes. Затем exact-source FULL либо
явно обоснованную более узкую проверку: её границы сообщаются отдельно.
Не использовать symlink node_modules для PG guard/Metro; locked dependencies можно
копировать отдельно, они не входят в source tree. Не включать private runtime data.
Временные `/tmp` report paths здесь — provenance, не постоянные пользовательские ссылки;
для долгосрочного evidence их нужно приложить к отдельной упаковке.

## Что индекс НЕ принимает
Native runtime/screenshots/devices/keyboard accessibility и двухустройственные E2E
остаются NOT_RUN/NOTaccepted в этих последних client этапах. JS export и исторический
Android assemble не закрывают эти gates. Нет production readiness, E2EE или blanket
app-security acceptance. Legacy Next gate NOT_RUN. Никаких новых функций или GitHub
writes этот recovery-docs этап не выполняет.

## Выполненное независимое восстановление initial recovery checkpoint
Проверенный recovery code/docs HEAD:
`904f9657dbaea889e1327da07bb9beb56977fb0f`, tree
`c438c76300f73a9bc2b79b7b38550431f319152f`.
Независимый reviewer восстановил свежую копию только из self-contained Git bundle:
31 достижимый commit,1303 tracked files; refs/tree/history, bytes и modes прошли
integrity-проверку. GitHub для восстановления не использовался.
На этой exact restored копии FULL11/11 PASS, sourceValid=true, clean before/after;
report `/tmp/pairspace-verification-ObuxpS/report.json`.
API880/mobile3093/real PostgreSQL469 PASS. Это новый FULL на904f965,
а не переименование прежнего отчёта ad06def.

Текущий финальный commit меняет только Map, Memory, ROADMAP и этот recovery index.
Продуктовый код идентичен2f7aafc. Его собственный hash фиксирует внешний manifest,
не сам документ. Final bundle ожидает пересборки с32 commits и независимой fresh-clone
integrity-проверки. Новый FULL на final docs HEAD не заявляется и не планируется:
runtime evidence относится к exact904f965, final verification ограничена integrity
и проверкой docs-only delta. Пока final integrity не завершена, это pending gate.
Remote не менялся; native/screenshots/devices NOT_RUN и не приняты.
