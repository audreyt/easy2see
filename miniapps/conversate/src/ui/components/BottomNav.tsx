import {FileText, History, MessageSquareText, Settings as SettingsGlyph} from "lucide-react"
import {useColorScheme} from "@mentra/miniapp/ui"

export type ConversateTab = "live" | "prep" | "history" | "settings"

interface BottomNavProps {
  activeTab: ConversateTab
  onTabChange: (tab: ConversateTab) => void
  accentColor?: string
}

const TABS: Array<{id: ConversateTab; label: string; Icon: typeof MessageSquareText}> = [
  {id: "live", label: "Live", Icon: MessageSquareText},
  {id: "prep", label: "Prep", Icon: FileText},
  {id: "history", label: "History", Icon: History},
  {id: "settings", label: "Settings", Icon: SettingsGlyph},
]

export function BottomNav({activeTab, onTabChange, accentColor = "#4F46E5"}: BottomNavProps) {
  const activeIconColor = readableIconColor(accentColor)
  const inactiveIconColor = useColorScheme() === "dark" ? "#A1A1AA" : "#3F3F46"

  return (
    <div className="w-full flex flex-col">
      <div className="w-full h-14 py-3 bg-white/80 dark:bg-zinc-900/80 rounded-tl-2xl rounded-tr-2xl backdrop-blur-lg flex flex-col justify-start items-center overflow-hidden">
        <div className="w-full flex justify-center items-end">
          {TABS.map(({id, label, Icon}) => (
            <div key={id} className="flex-1 inline-flex flex-col justify-start items-center gap-1">
              <button
                aria-label={label}
                onClick={() => onTabChange(id)}
                className="w-12 h-7 p-2 rounded-3xl inline-flex justify-center items-center transition-colors"
                style={activeTab === id ? {backgroundColor: accentColor} : {backgroundColor: "transparent"}}>
                <Icon
                  aria-hidden="true"
                  className="w-6 h-6"
                  strokeWidth={2}
                  color={activeTab === id ? activeIconColor : inactiveIconColor}
                  opacity={activeTab === id ? 1 : 0.65}
                />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function readableIconColor(background: string): string {
  const hex = background.replace("#", "")
  if (!/^[\da-f]{6}$/i.test(hex)) return "#FFFFFF"
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
  return luminance > 0.42 ? "#18181B" : "#FFFFFF"
}

function linearize(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}
