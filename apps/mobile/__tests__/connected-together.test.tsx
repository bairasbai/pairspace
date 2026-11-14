import {createStemsController} from '../src/auth/stems';
import {createScaleController} from '../src/auth/scale';
import {fireEvent,render,screen} from '@testing-library/react-native';
import {ConnectedTogether} from '../src/auth/ConnectedTogether';
import {createAsksController} from '../src/auth/asks';
import {createLoveWordsController} from '../src/auth/love-words';
it.each(['ru','en'] as const)('keeps both together tools accessible with an explicit selector %s',locale=>{
 const config={mode:'synthetic-loopback' as const,baseURL:'http://localhost:8787'};
 const host={capture:()=>null,getCookie:async()=>'',block:jest.fn(),refresh:async()=>{}};
 const request=jest.fn(async()=>{throw Error('Navigation must not fetch');});
 const controller={stems:createStemsController(config,host,request,()=> 'command').actions,scale:createScaleController(config,host,request,()=> 'command').actions,asks:createAsksController(config,host,request,()=> 'command').actions,loveWords:createLoveWordsController(config,host,request,()=> 'command').actions};
 render(<ConnectedTogether controller={controller} locale={locale}/>);
 const words=screen.getByRole('tab',{name:locale==='ru'?'Словарь':'Dictionary'}),asks=screen.getByRole('tab',{name:locale==='ru'?'Вопросы':'Questions'});
 expect(words.props.accessibilityState.selected).toBe(true);expect(asks.props.accessibilityState.selected).toBe(false);
 fireEvent.press(asks);expect(asks.props.accessibilityState.selected).toBe(true);
 const scale=screen.getByRole('tab',{name:locale==='ru'?'Шкала дня':'Day scale'});fireEvent.press(scale);expect(scale.props.accessibilityState.selected).toBe(true);
 const stems=screen.getByRole('tab',{name:locale==='ru'?'Продолжи фразу':'Continue phrase'});fireEvent.press(stems);expect(stems.props.accessibilityState.selected).toBe(true);
 fireEvent.press(words);expect(words.props.accessibilityState.selected).toBe(true);expect(request).not.toHaveBeenCalled();
});
