import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryStore } from './historySlice';
import { useOptimisticStore } from './eventsSlice';
import { restoreDeletedEvent } from '../api/write';
vi.mock('../api/write',()=>({restoreDeletedEvent:vi.fn(),createEvent:vi.fn(),updateEvent:vi.fn(),deleteEvent:vi.fn(),moveEvent:vi.fn(),resizeEvent:vi.fn()}));
beforeEach(()=>{useHistoryStore.getState().clear();useOptimisticStore.getState().clearAll();vi.clearAllMocks();});
describe('persistent trash undo',()=>{
  it('restores a deleted exception from its saved snapshot',async()=>{
    vi.mocked(restoreDeletedEvent).mockResolvedValue({uid:'restored'});
    useHistoryStore.getState().record({kind:'delete',uid:'original',scope:'single',before:{uid:'original',calendar_id:'cal',summary:'Exception',start:'2026-09-21T10:00:00',end:'2026-09-21T11:00:00',all_day:false,is_recurring:true,rrule:'FREQ=WEEKLY',recurrence_id:'2026-09-21T09:00:00'},after:null});
    expect(await useHistoryStore.getState().undo()).toBe(true);
    expect(restoreDeletedEvent).toHaveBeenCalledWith('original','single','2026-09-21T09:00:00');
    expect(useHistoryStore.getState().future[0]).toMatchObject({uid:'restored',scope:'all',before:{is_recurring:false,rrule:null,recurrence_id:null}});
  });
  it('keeps undo available after a failed server restore',async()=>{
    vi.mocked(restoreDeletedEvent).mockRejectedValue({type:'caldav_down'});
    useHistoryStore.getState().record({kind:'delete',uid:'original',before:{uid:'original',calendar_id:'cal',summary:'Test',start:'2026-09-21T10:00:00',end:'2026-09-21T11:00:00',all_day:false},after:null});
    await expect(useHistoryStore.getState().undo()).rejects.toEqual({type:'caldav_down'});
    expect(useHistoryStore.getState().past).toHaveLength(1);
  });
});
