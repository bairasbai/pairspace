import { validQuiet, validFields, validPreferences, validPreview, copyFields, sameFields, defaultNotificationFields } from '../src/auth/notification-preferences-state';
import { date,context,uuid } from './notification-preferences-fixtures';
it('validates private defaults/schema and quiet ranges without canonicalizing aliases',()=>{
 expect(validPreferences({...date,version:0},context)).toBe(true);expect(validPreferences(date,context)).toBe(true);
 expect(validQuiet({start:'23:00',end:'06:00',timezone:'Japan'})).toBe(true);
 for(const quiet of [[],{}, {start:1,end:'07:00',timezone:'UTC'},{start:'22:00',end:1,timezone:'UTC'},{start:'22:00',end:'07:00',timezone:1},
 {start:'25:00',end:'07:00',timezone:'UTC'},{start:'22:00',end:'25:00',timezone:'UTC'},{start:'22:00',end:'22:00',timezone:'UTC'},
 {start:'22:00',end:'07:00',timezone:'x'.repeat(101)},{start:'22:00',end:'07:00',timezone:'+03:00'}, {start:'22:00',end:'07:00',timezone:'Fake/Zone'}])expect(validQuiet(quiet)).toBe(false);
 for(const value of [null,{}, {...date,extra:true},{...date,userId:uuid(8)},{...date,coupleId:uuid(8)},{...date,membershipEpoch:2},{...date,preview:'text'},
 {...date,version:-1},{...date,version:2147483648},{...date,version:0,care:true},{...date,chat:1},{...date,letter:null},{...date,care:'true'}])expect(validPreferences(value,context)).toBe(false);
 expect(validPreferences(date,{state:'signed_out'} as never)).toBe(false);expect(validFields(null)).toBe(false);
});
it('copies nested fields defensively and compares quiet hour fields exactly',()=>{
 const q={start:'22:00',end:'07:00',timezone:'UTC'},a=copyFields({...defaultNotificationFields,quiet:q});q.start='21:00';expect(a.quiet?.start).toBe('22:00');
 expect(sameFields(a,{...a,quiet:{...a.quiet!}})).toBe(true);
 for(const b of [{...a,quiet:null},{...a,care:true},{...a,chat:true},{...a,letter:true},{...a,quiet:{...q,end:'08:00'}},{...a,quiet:{...a.quiet!,end:'08:00'}},{...a,quiet:{...a.quiet!,timezone:'Japan'}}])expect(sameFields(a,b)).toBe(false);
 expect(sameFields(defaultNotificationFields,a)).toBe(false);
});
it('preview cannot masquerade as delivery or expose extra payload',()=>{
 const p={allowedByPreferences:true,reason:'allowed',category:'care',asOf:'2028-01-01T00:00:00.000Z',preferenceVersion:1,simulationOnly:true};expect(validPreview(p,'care')).toBe(true);
 for(const v of [null,{...p,extra:'body'},{...p,category:'chat'},{...p,simulationOnly:false},{...p,asOf:'bad'},{...p,preferenceVersion:-1},{...p,preferenceVersion:2147483648},{...p,reason:'sent'},{...p,allowedByPreferences:false}])expect(validPreview(v,'care')).toBe(false);
});

it('version zero previews can only represent default disabled categories',()=>{
 const p={allowedByPreferences:false,reason:'disabled',category:'care',asOf:'2028-01-01T00:00:00.000Z',preferenceVersion:0,simulationOnly:true};
 expect(validPreview(p,'care')).toBe(true);
 expect(validPreview({...p,reason:'allowed',allowedByPreferences:true},'care')).toBe(false);
 expect(validPreview({...p,reason:'quiet_hours'},'care')).toBe(false);
});
