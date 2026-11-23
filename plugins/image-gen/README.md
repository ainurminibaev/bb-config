# Image Gen — генерация и правка картинок для всех агентов BB

BB-плагин. Codex рисует сам встроенным `image_gen`. Claude, Pi, Cursor и другие провайдеры
вызывают `image_generate` / `image_edit` (или `bb image-gen generate|edit`): плагин запускает
`codex exec` на подходящей машине BB обычным процессом (без служебных тредов), проверяет файл
по SHA-256 и кладёт его в папку проекта вызывающего. Без Codex — по желанию платный OpenAI API.

Подробно: [docs/architecture.md](docs/architecture.md).

## Установка

```bash
bb plugin install 'git:https://github.com/ainurminibaev/bb-config.git@^0.1.0' \
  --subdirectory plugins/image-gen --tag-prefix image-gen/ --yes
bb image-gen services        # какие машины готовы и чего не хватает
```

На машинах-исполнителях: Codex CLI с `codex login` (подписка ChatGPT) и python3 ≥ 3.9.
Без Codex: `bb plugin config image-gen set maxTier 1` и ключ OpenAI API в настройках плагина (секретное поле).

## Обновление и откат

`bb plugin update image-gen` (BB также сам проверяет совместимые релизы). Откат — установка
предыдущего тега: `bb plugin install 'git:…bb-config.git@image-gen/v0.1.4' --subdirectory plugins/image-gen --yes`.

## Разработка

```bash
npm ci --ignore-scripts
npm run build      # встраивает runner/imagegen_runner.py и собирает dist/
npm test           # core + e2e на собранном плагине с подставным BB и Codex + runner
```

Реальных генераций тесты не делают. Новая версия: поднять `version` в package.json, `npm run build`,
`npm test`, тег `image-gen/vX.Y.Z` на коммите main, push.

Правила: исходник исполнителя — `runner/imagegen_runner.py`, после правки `npm run build` и `npm test`;
авторизацию Codex и ключи не читать и не копировать (ключ OpenAI — только секретная настройка плагина);
служебных тредов BB для генерации нет; исход «unknown» автоматически не повторяется.
