import { parseArrivalFields, validArrival } from '../src/auth/arrival-state';
import { date, context, uuid } from './arrival-fixtures';
it('validates canonical plan and rejects mismatched snapshots/private schema',()=>{
 expect(validArrival(date,context)).toBe(true);expect(validArrival({...date,label:''},context)).toBe(true);expect(parseArrivalFields({...date,label:'  '})).toMatchObject({label:''});expect(parseArrivalFields({...date,label:' Shared plan '})).toMatchObject({label:'Shared plan'});
 for(const value of [null,[],{}, {...date,extra:'private'}, {...date,label:1},{...date,localTime:1},{...date,offset:1},{...date,timezone:1},{...date,localDate:1},
 {...date,label:'  label '},{...date,timezone:'Japan'},{...date,id:'bad'},{...date,creatorId:'bad'},{...date,coupleId:uuid(8)},
 {...date,membershipEpoch:2},{...date,version:0},{...date,version:2147483648},{...date,createdAt:'bad'},{...date,arrivesAt:'2028-02-29T01:00:00.000Z'},
 {...date,localDate:'2028-02-30'},{...date,localTime:'25:00'},{...date,offset:'-00:00'}])expect(validArrival(value,context)).toBe(false);
 expect(validArrival(date,{state:'signed_out'} as never)).toBe(false);
});
it('requires explicit matching fold offset, rejects DST gap and outside years',()=>{
 const civil={...date,timezone:'America/New_York',localDate:'2026-11-01',localTime:'01:30'};
 expect(parseArrivalFields({...civil,offset:'-04:00'})).not.toBeNull();expect(parseArrivalFields({...civil,offset:'-05:00'})).not.toBeNull();
 expect(parseArrivalFields({...civil,offset:'-06:00'})).toBeNull();
 expect(parseArrivalFields({...civil,localDate:'2026-03-08',localTime:'02:30',offset:'-05:00'})).toBeNull();
 expect(parseArrivalFields({...date,localDate:'1999-12-31'})).toBeNull();expect(parseArrivalFields({...date,localDate:'2101-01-01'})).toBeNull();
});
