import { fireEvent, render, screen } from '@testing-library/react-native';
import { LoveWordsPanel } from '../src/auth/LoveWordsPanel';
import type { LoveWordsActions } from '../src/auth/love-words';
import type { LoveWordsView, LoveWord } from '../src/auth/love-words-state';
const own = '00000000-0000-4000-8000-000000000001';
const entry: LoveWord = { id: '00000000-0000-4000-8000-000000000010', coupleId: '00000000-0000-4000-8000-000000000099', authorId: own, membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-01-01T00:00:00.000Z', state: 'active', word: 'Тепло', meaning: 'Our meaning', saidWhen: 'Morning', edited: false };
const fields = { word: '', meaning: '', saidWhen: '' };
const base: LoveWordsView = { userId: own, available: true, busy: false, checked: false, checkedAt: null, words: [], used: 0, capacity: 100, create: fields, editor: null, pending: false, requiresRefresh: false, error: false, status: 'idle' };
function fixture() {
    let view = base;
    const controller = { getSnapshot: () => view, subscribe: jest.fn(() => () => { }), load: jest.fn(async () => { }), setCreateField: jest.fn(), setEditField: jest.fn(), beginEdit: jest.fn(), cancelCreate: jest.fn(), cancelEdit: jest.fn(), create: jest.fn(async () => { }), saveEdit: jest.fn(async () => { }), remove: jest.fn(async () => { }), retry: jest.fn(async () => { }) } satisfies LoveWordsActions;
    return { controller, set: (next: LoveWordsView) => { view = next; } };
}
it.each(['ru', 'en'] as const)('renders honest dictionary and separate drafts, all callbacks %s', locale => {
    const f = fixture(), props = { controller: f.controller, locale, userId: own };
    f.set({ ...base, available: false });
    const ui = render(<LoveWordsPanel {...props}/>);
    expect(ui.toJSON()).toBeNull();
    const update = (next: LoveWordsView) => { f.set(next); ui.rerender(<LoveWordsPanel {...props}/>); };
    update(base);
    const labels = locale === 'ru' ? ['Новое слово: Слово (до 120 символов)', 'Новое слово: Значение (необязательно, до 1000 символов)', 'Новое слово: Когда говорим (необязательно, до 1000 символов)'] : ['New word: Word (up to 120 characters)', 'New word: Meaning (optional, up to 1000 characters)', 'New word: When we say it (optional, up to 1000 characters)'];
    labels.forEach((label, i) => fireEvent.changeText(screen.getByLabelText(label), 'Draft ' + i));
    expect(f.controller.setCreateField.mock.calls).toEqual([['word', 'Draft 0'], ['meaning', 'Draft 1'], ['saidWhen', 'Draft 2']]);
    for (const label of locale === 'ru' ? ['Сохранить новое слово для обоих', 'Отменить ввод нового слова', 'Обновить весь словарь'] : ['Save new word for both', 'Cancel new word', 'Refresh entire dictionary'])
        fireEvent.press(screen.getByText(label));
    expect(f.controller.create).toHaveBeenCalledTimes(1);
    expect(f.controller.cancelCreate).toHaveBeenCalledTimes(1);
    expect(f.controller.load).toHaveBeenCalledTimes(1);
    update({ ...base, checked: true });
    expect(screen.getByText(locale === 'ru' ? 'В проверенном словаре пока нет слов.' : 'No words in the checked dictionary yet.')).toBeTruthy();
    const partner = { ...entry, id: 'partner', authorId: 'partner', sequence: 2, word: 'Partner word', meaning: '', saidWhen: '' };
    const deleted: LoveWord = { id: 'deleted', coupleId: entry.coupleId, authorId: own, membershipEpoch: 1, sequence: 3, version: 2, createdAt: entry.createdAt, state: 'deleted' };
    update({ ...base, checked: true, checkedAt: entry.createdAt, words: [entry, partner, deleted], used: 3, editor: { id: entry.id, version: 1, fields: { word: 'Edit', meaning: 'Meaning', saidWhen: 'When' } } });
    expect(screen.getByText(locale === 'ru' ? 'Автор: Вы' : 'Author: You')).toBeTruthy();
    expect(screen.getByText(locale === 'ru' ? 'Автор: Партнёр' : 'Author: Partner')).toBeTruthy();
    expect(screen.queryByText(locale === 'ru' ? 'Изменить 2' : 'Edit 2')).toBeNull();
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Изменить 1' : 'Edit 1'));
    expect(f.controller.beginEdit).toHaveBeenCalledWith(entry.id);
    for (const [i, key] of ['word', 'meaning', 'saidWhen'].entries()) {
        const prefix = locale === 'ru' ? 'Изменение своего слова' : 'Edit your word';
        const label = labels[i].slice(labels[i].indexOf(':') + 2);
        fireEvent.changeText(screen.getByLabelText(`${prefix}: ${label}`), 'Edit ' + i);
        expect(f.controller.setEditField).toHaveBeenCalledWith(key, 'Edit ' + i);
    }
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Сохранить изменения для обоих' : 'Save changes for both'));
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Отменить редактирование' : 'Cancel editing'));
    expect(f.controller.saveEdit).toHaveBeenCalledTimes(1);
    expect(f.controller.cancelEdit).toHaveBeenCalledTimes(1);
    const remove = locale === 'ru' ? 'Удалить 1' : 'Delete 1';
    fireEvent.press(screen.getByText(remove));
    expect(f.controller.remove).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Нет, оставить' : 'No, keep it'));
    expect(f.controller.remove).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(remove));
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Да, удалить для обоих' : 'Yes, delete for both'));
    expect(f.controller.remove).toHaveBeenCalledWith(entry.id, true);
    update({ ...base, pending: true, status: 'retry', error: true });
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Повторить ту же команду' : 'Retry same command'));
    expect(f.controller.retry).toHaveBeenCalledTimes(1);
    fireEvent.changeText(screen.getByLabelText(labels[0]), 'Newer draft');
    expect(f.controller.setCreateField).toHaveBeenLastCalledWith('word', 'Newer draft');
    update({ ...base, busy: true, requiresRefresh: true, status: 'saving' });
    fireEvent.press(screen.getByText(locale === 'ru' ? 'Обновить весь словарь' : 'Refresh entire dictionary'));
    expect(f.controller.load).toHaveBeenCalledTimes(1);
    for (const status of ['saved', 'invalid', 'conflict', 'unavailable', 'limit'] as const)
        update({ ...base, status });
});
it('lifetime cap blocks creates, not editing; stale confirmation cannot delete changed entry or another actor', () => {
    const f = fixture(), props = { controller: f.controller, locale: 'en' as const };
    const full = { ...base, used: 100, words: [entry], editor: { id: entry.id, version: 1, fields } };
    f.set(full);
    const ui = render(<LoveWordsPanel {...props}/>);
    expect(screen.getByText('Remaining capacity in known data: 0')).toBeTruthy();
    fireEvent.press(screen.getByText('Save new word for both'));
    expect(f.controller.create).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Save changes for both'));
    expect(f.controller.saveEdit).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByText('Delete 1'));
    f.set({ ...full, words: [{ ...entry, version: 2, edited: true }] });
    ui.rerender(<LoveWordsPanel {...props}/>);
    expect(screen.queryByText('Yes, delete for both')).toBeNull();
    fireEvent.press(screen.getByText('Delete 1'));
    ui.rerender(<LoveWordsPanel {...props} userId="other"/>);
    expect(screen.queryByText('Yes, delete for both')).toBeNull();
    ui.rerender(<LoveWordsPanel {...props}/>);
    const tombstone: LoveWord = { id: entry.id, coupleId: entry.coupleId, authorId: own, membershipEpoch: 1, sequence: 1, version: 3, createdAt: entry.createdAt, state: 'deleted' };
    f.set({ ...full, words: [tombstone], editor: null });
    ui.rerender(<LoveWordsPanel {...props}/>);
    expect(screen.queryByText('Yes, delete for both')).toBeNull();
    expect(screen.queryByText('Тепло')).toBeNull();
    f.set({ ...full, busy: true, pending: true });
    ui.rerender(<LoveWordsPanel {...props}/>);
    fireEvent.press(screen.getByText('Save changes for both'));
    expect(f.controller.saveEdit).toHaveBeenCalledTimes(1);
});
it.each(['ru', 'en'] as const)('stale dirty editor is labeled, editable and cancellable but not saveable %s', locale => {
    const f = fixture(), props = { controller: f.controller, locale };
    const ui = render(<LoveWordsPanel {...props}/>);
    for (const stale of ['changed', 'deleted'] as const) {
        f.set({ ...base, editor: { id: entry.id, version: 1, fields: { word: 'Unsaved newer text', meaning: '', saidWhen: '' }, stale } });
        ui.rerender(<LoveWordsPanel {...props}/>);
        const notice = locale === 'ru' ? (stale === 'changed' ? 'Запись изменилась.' : 'Запись удалена.') : (stale === 'changed' ? 'This entry changed.' : 'This entry was deleted.');
        expect(screen.getByText(new RegExp(notice))).toBeTruthy();
        fireEvent.press(screen.getByText(locale === 'ru' ? 'Сохранить изменения для обоих' : 'Save changes for both'));
        expect(f.controller.saveEdit).not.toHaveBeenCalled();
        fireEvent.changeText(screen.getByDisplayValue('Unsaved newer text'), 'Still editable');
        expect(f.controller.setEditField).toHaveBeenLastCalledWith('word', 'Still editable');
        fireEvent.press(screen.getByText(locale === 'ru' ? 'Отменить редактирование' : 'Cancel editing'));
    }
    expect(f.controller.cancelEdit).toHaveBeenCalledTimes(2);
});
