// app/api/agents/route.ts
import { NextResponse } from 'next/server';
import { getAgents } from '@/lib/agents';

export async function GET() {
  try {
    const agents = getAgents();
    return NextResponse.json({ agents });
  } catch (error) {
    console.error('Failed to get agents:', error);
    return NextResponse.json({ agents: [], error: 'Failed to fetch agents' }, { status: 500 });
  }
}
