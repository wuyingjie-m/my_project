// app/api/daily/route.ts
import { NextResponse } from 'next/server';
import { getTodayItems } from '@/lib/daily';

export async function GET() {
  try {
    const items = getTodayItems();
    return NextResponse.json({ 
      items, 
      date: new Date().toISOString().split('T')[0] 
    });
  } catch (error) {
    console.error('Failed to get daily items:', error);
    return NextResponse.json({ items: [], date: new Date().toISOString().split('T')[0] }, { status: 500 });
  }
}
