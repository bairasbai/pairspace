# Общие желания: первый synthetic-срез

Отдельная коллекция желаний, не список дел, покупок или тайных сюрпризов.
Это улучшенный bounded-сценарий строки P1 [карты Tan Ata](TAN_ATA_MAP.md),
а не полный перенос исходной страницы. Все данные тестовые.

## Публикация и видимость
- Название: нормализованный NFC plain text, 1–200 Unicode scalars. Необязательное
  пояснение: 0–600 scalars, NFC, CRLF/CR → LF; нет control/format/surrogate знаков,
  кроме LF в пояснении. Пустое поле передаётся как явная пустая строка.
- RAM-черновик не отправляется автоматически. Checkbox сообщает, что название и
  пояснение увидят оба партнёра; изменение любого поля сбрасывает согласие.
  Кнопка публикации создаёт неизменную команду. Это не публикация личных заметок.
- Создатель сохраняется навсегда. Название и пояснение после создания нельзя
  редактировать или удалить в этом срезе; интерфейс предупреждает до отправки.
- Любой из двух активных участников может явно отметить «Исполнено» или вернуть
  желание. Это запись общего состояния, не обещание исполнить чужое желание.
  Назначений, покупок, ссылок, доставки, outbox/push и фоновых уведомлений нет.

## HTTP и PostgreSQL
Отдельный opt-in `enableSyntheticSharedWishes`, по умолчанию выключен,
только loopback. Текущая session authority, ровно два активных участника,
пара и membership epoch проверяются до чтения receipt или записи.
- GET /v1/couples/:id/wishes?membership_epoch=N: последние 50 по createdAt DESC,
  id DESC. Изменение статуса не меняет порядок; это не полный архив.
- POST /v1/couples/:id/wishes: command_id, membership_epoch, title, explanation.
- POST /v1/couples/:id/wishes/:wishId: command_id, membership_epoch,
  expected_version, operation `fulfill` / `reopen`.
- Idempotency-Key совпадает с command_id. Неизвестные поля, неверный content-type,
  query на POST, лишние query/неверные методы отклоняются. No-store, origin и
  существующие body/time limits сохранены. Ответы ошибок не раскрывают текст.
- Migration019 создаёт shared_wishes/shared_wish_commands независимо от tasks.
  Status CAS: open → fulfilled → open, каждый переход повышает version ровно на 1.
  Уже целевой статус или устаревшая версия: конфликт без перезаписи.
- Immutable actor+command receipts сохраняют исходный payload/expectedVersion.
  Historical retry возвращает canonical текущее состояние вместе с appliedVersion,
  а не устаревший статус. Сбой receipt откатывает создание/переход целиком.
- Lock order совпадает с pair closure: historical users → session → pair →
  свежая session. Закрытие пары запрещает чтение, изменение и исторический retry.
  Строки сохраняются без нового решения об архиве, retention или удалении.

## Клиент и ограничения
Перед каждым чтением/изменением клиент проверяет контекст и cookie, связывает
callback с generation/session/user/pair/epoch. Unknown ACK повторяет ровно старую
команду; новый черновик не теряется. Конфликт требует ручного refresh и нового
явного действия. Очистка формы не отменяет уже отправленную команду.
Logout/смена пары/epoch/unmount очищают RAM и блокируют старые callbacks.

Сервер хранит plaintext, не E2EE. Default offline demo, main/Kimi reference
не меняются. Durable drafts, личные желания, архив, редактирование/удаление,
пагинация, уведомления и production-политика остаются в плане.
Native/device/two-device E2E и legacy Next NOT_RUN; JS export не native build.
[Доказательства](SHARED_WISHES_EVIDENCE.md), [мобильный контракт](../apps/mobile/SHARED_WISHES.md).
