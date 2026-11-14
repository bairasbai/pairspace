import { fireEvent,render,screen } from '@testing-library/react-native';
import { NotificationPreferencesPanel } from '../src/auth/NotificationPreferencesPanel';
import { emptyNotifications } from '../src/auth/notification-preferences-state';
import { date } from './notification-preferences-fixtures';
it.each(['ru','en'] as const)('explicit private rule controls and simulation-only copy %s',locale=>{
 const callbacks={onCategory:jest.fn(),onQuiet:jest.fn(),onLoad:jest.fn(),onSave:jest.fn(),onRetry:jest.fn(),onEdit:jest.fn(),onCancel:jest.fn(),onPreview:jest.fn()};const props={...callbacks,locale};
 const view={...emptyNotifications,available:true};const ui=render(<NotificationPreferencesPanel {...props} view={emptyNotifications}/>);expect(ui.toJSON()).toBeNull();ui.rerender(<NotificationPreferencesPanel {...props} view={view}/>);
 for(const label of locale==='ru'?['Думаю о тебе','Чат','Письма']:['Thinking of you','Chat','Letters'])fireEvent(screen.getByLabelText(label),'valueChange',true);expect(callbacks.onCategory).toHaveBeenCalledTimes(3);
 const quiet=locale==='ru'?'Тихие часы':'Quiet hours';fireEvent(screen.getByLabelText(quiet),'valueChange',true);expect(callbacks.onQuiet).toHaveBeenCalledWith({start:'',end:'',timezone:''});fireEvent(screen.getByLabelText(quiet),'valueChange',false);expect(callbacks.onQuiet).toHaveBeenCalledWith(null);
 ui.rerender(<NotificationPreferencesPanel {...props} view={{...view,checked:true,preferences:date,asOf:'2028-01-01T00:00:00.000Z',fields:{...view.fields,quiet:{start:'22:00',end:'07:00',timezone:'UTC'}}}}/>);
 for(const label of locale==='ru'?['Начало HH:mm','Конец HH:mm','Пояс тихих часов IANA']:['Start HH:mm','End HH:mm','Quiet-hours IANA time zone'])fireEvent.changeText(screen.getByLabelText(label),'x');expect(callbacks.onQuiet).toHaveBeenCalledTimes(5);
 for(const label of locale==='ru'?['Загрузить мои правила','Редактировать проверенные правила','Сохранить мои правила','Сбросить форму']:['Load my rules','Edit checked rules','Save my rules','Reset form'])fireEvent.press(screen.getByText(label));
 expect(callbacks.onLoad).toHaveBeenCalledTimes(1);expect(callbacks.onSave).toHaveBeenCalledTimes(1);expect(callbacks.onEdit).toHaveBeenCalledTimes(1);expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
 fireEvent.press(screen.getByText(locale==='ru'?'Проверить правило сейчас: Чат':'Check rule now: Chat'));expect(callbacks.onPreview).toHaveBeenCalledWith('chat');
 ui.rerender(<NotificationPreferencesPanel {...props} view={{...view,pending:view.fields,status:'retry',error:true,policyPreview:{allowedByPreferences:false,reason:'quiet_hours',category:'letter',asOf:'2028-01-01T00:00:00.000Z',preferenceVersion:1,simulationOnly:true}}}/>);
 fireEvent.press(screen.getByText(locale==='ru'?'Повторить ту же команду':'Retry same command'));expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
 fireEvent.press(screen.getByText(locale==='ru'?'Сохранить мои правила':'Save my rules'));expect(callbacks.onSave).toHaveBeenCalledTimes(1);
 ui.rerender(<NotificationPreferencesPanel {...props} view={{...view,busy:true,requiresRefresh:true}}/>);fireEvent.press(screen.getByText(locale==='ru'?'Загрузить мои правила':'Load my rules'));expect(callbacks.onLoad).toHaveBeenCalledTimes(1);
});
