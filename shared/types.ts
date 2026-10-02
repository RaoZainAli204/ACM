export type EventState = 'closed' | 'lobby' | 'countdown' | 'racing' | 'frozen';
export interface PublicEvent { id: string; name: string; state: EventState; startAt: number | null; endAt: number | null; test: boolean }
export interface Standing { publicId: string; name: string; score: number; progress: number; rank: number | null; movement: number; finished: boolean }
export interface PublicSnapshot { serverNow: number; event: PublicEvent; count: number; standings: Standing[]; unfinished: Standing[]; cutoffTie: boolean; joinUrl: string }
export interface IssuedQuestion { id: string; number: number; text: string; image: string | null; imageAlt: string | null; options: { id: string; text: string }[]; issuedAt: number; deadline: number; allowanceMs: number }
export interface PlayerSnapshot { serverNow: number; event: PublicEvent; player: { publicId: string; name: string; score: number; progress: number; rank: number | null; finished: boolean; adjustedMs: number }; question: IssuedQuestion | null; review?: { number: number; text: string; selected: string | null; correct: string; explanation: string; earned: number }[] }
export interface AnswerInput { questionId: string; optionId: string; requestId: string }
export interface Receipt { questionId: string; requestId: string | null; earned: number; adjustedMs: number; timedOut: boolean; acceptedAt: number }
