// Types for R&D Council Dashboard

export type Stage = 'trending' | 'opportunity' | 'council';
export type SessionType = 'scheduled' | 'emergency';
export type TimeOfDay = 'morning' | 'evening';
export type Decision = 'approved' | 'rejected' | 'sent_back' | 'snoozed' | null;
export type EscalationType = 'auto' | 'manual_normal' | 'manual_urgent';
export type OriginType = 'reactive' | 'proactive';
export type ProactiveLens = 'efficiency' | 'infrastructure' | 'pattern' | 'external' | null;
export type CouncilConfidence = 'low' | 'medium' | 'high';

export interface CouncilItem {
  id: string;
  title: string;
  summary: string;
  created_at: string;
  stage: Stage;
  council_session_id: string;
  promotion_reason: string;
  proposing_model: string;
  origin_type: OriginType;
  origin_tags: string[];
  proactive_lens: ProactiveLens;
  idea_ledger_id: string;
  council_confidence: CouncilConfidence;
  debate_summary: string[];
  key_disagreements: { model: string; concern: string; resolution: string }[];
  council_recommendation: string;
  passing_reasoning: string;
  escalation_type: EscalationType;
  session_type: SessionType;
  scheduled_for: string;
  session_time_of_day: TimeOfDay;
  decision: Decision;
  decision_note?: string;
  decision_at?: string;
  snooze_until?: string;
  is_hidden: boolean;
  hidden_until?: string;
}

export interface Memo {
  id: string;
  session_id: string;
  session_time: string;
  proposer: string;
  summary: string;
  recommendations: string[];
  created_at: string;
}
