import { render, fireEvent } from '@testing-library/react-native';
import { ChatEditPanel, editCopy } from '../src/auth/ChatEditPanel';
it.each(['ru', 'en'] as const)('%s edit is explicit, conflict reload and unknown retry are distinct', locale => {
    const t = editCopy[locale], save = jest.fn(), draft = jest.fn(), cancel = jest.fn(), retry = jest.fn(), reload = jest.fn();
    const props = { locale, onSave: save, onDraft: draft, onCancel: cancel, onRetry: retry, onReload: reload };
    const screen = render(<ChatEditPanel {...props}/>);
    expect(screen.queryByText(t.save)).toBeNull();
    screen.rerender(<ChatEditPanel {...props} state={{ status: 'editing', targetId: 'id', draft: 'body', needsReload: false }}/>);
    expect(save).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText(t.draft), 'new');
    expect(draft).toHaveBeenCalledWith('new');
    fireEvent.press(screen.getByText(t.save));
    fireEvent.press(screen.getByText(t.cancel));
    fireEvent.press(screen.getByText(t.reload));
    expect(save).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    screen.rerender(<ChatEditPanel {...props} state={{ status: 'unknown', targetId: 'id', draft: 'new', needsReload: false }}/>);
    expect(screen.queryByText(t.save)).toBeNull();
    expect(screen.queryByText(t.cancel)).toBeNull();
    fireEvent.press(screen.getByText(t.retry));
    expect(retry).toHaveBeenCalledTimes(1);
    for (const status of ['conflict', 'deleted', 'saved'] as const) {
        screen.rerender(<ChatEditPanel {...props} state={{ status, targetId: 'id', draft: 'new', needsReload: status !== 'saved' }}/>);
        expect(screen.getByText(t[status])).toBeTruthy();
    }
});
