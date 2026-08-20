'use client';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost" size="icon-sm"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Zu hell wechseln' : 'Zu dunkel wechseln'}
      title="Umschalten (Taste D)"
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
