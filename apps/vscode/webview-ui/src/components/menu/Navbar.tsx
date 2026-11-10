import { HistoryIcon, PlusIcon, PuzzleIcon, SettingsIcon, UserCircleIcon } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "../../context/ExtensionStateContext"

interface NavbarProps {
	startNewTask: (source: "navbar") => Promise<boolean>
}

export const Navbar = ({ startNewTask }: NavbarProps) => {
	const { navigateToHistory, navigateToSettings, navigateToAccount, navigateToMarketplace, navigateToChat } =
		useExtensionState()

	const SETTINGS_TABS = useMemo(
		() => [
			{
				id: "chat",
				name: "Chat",
				tooltip: "New Task",
				icon: PlusIcon,
				navigate: async () => {
					try {
						if (await startNewTask("navbar")) {
							navigateToChat()
						}
					} catch (error) {
						console.error("Failed to clear task:", error)
					}
				},
			},
			{
				id: "customize",
				name: "Customize",
				tooltip: "Customize",
				icon: PuzzleIcon,
				navigate: navigateToMarketplace,
			},
			{
				id: "history",
				name: "History",
				tooltip: "History",
				icon: HistoryIcon,
				navigate: navigateToHistory,
			},
			{
				id: "account",
				name: "Account",
				tooltip: "Account",
				icon: UserCircleIcon,
				navigate: navigateToAccount,
			},
			{
				id: "settings",
				name: "Settings",
				tooltip: "Settings",
				icon: SettingsIcon,
				navigate: navigateToSettings,
			},
		],
		[navigateToAccount, navigateToChat, navigateToHistory, navigateToMarketplace, navigateToSettings, startNewTask],
	)

	return (
		<header
			className="flex-none flex items-center justify-between px-3.5 py-2 border-b border-white/[0.06] bg-editor-background/60 backdrop-blur-md z-10"
			id="zentrix-navbar-container">
			{/* Brand identity on left */}
			<div className="flex items-center gap-2.5 min-w-0">
				<div className="flex items-center gap-1.5 cursor-pointer select-none" onClick={() => navigateToChat()}>
					<svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
						<rect x="6" y="6" width="116" height="116" rx="26" fill="#0F172A" stroke="rgba(255,255,255,0.15)" strokeWidth="4" />
						<path d="M30 32 H94 C96.8 32 98.4 35.1 96.8 37.3 L79 60 H48 C44.7 60 42 57.3 42 54 L38 36 C38 33.8 35.8 32 33.6 32 Z" fill="#38BDF8" />
						<polygon points="84,36 34,92 48,92 96,40 96,36" fill="#F8FAFC" />
						<path d="M98 96 H34 C31.2 96 29.6 92.9 31.2 90.7 L49 68 H80 C83.3 68 86 70.7 86 74 L90 92 C90 94.2 92.2 96 94.4 96 Z" fill="#6366F1" />
					</svg>
					<span className="font-semibold tracking-[0.14em] text-xs text-text-primary uppercase">
						Zentrix
					</span>
				</div>
				<div className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 select-none">
					<span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
					<span>TrueForge</span>
				</div>
			</div>

			{/* Action toolbar on right */}
			<nav className="inline-flex items-center gap-1">
				{SETTINGS_TABS.map((tab) => (
					<Tooltip key={`navbar-tooltip-${tab.id}`}>
						<TooltipContent side="bottom">{tab.tooltip}</TooltipContent>
						<TooltipTrigger asChild>
							<Button
								aria-label={tab.tooltip}
								className="size-7 p-0 rounded-md hover:bg-white/[0.08] transition-colors"
								data-testid={`tab-${tab.id}`}
								key={`navbar-button-${tab.id}`}
								onClick={() => tab.navigate()}
								size="icon"
								variant="icon">
								<tab.icon className="stroke-1 [svg]:size-3.5 text-text-secondary hover:text-text-primary transition-colors" size={16} />
							</Button>
						</TooltipTrigger>
					</Tooltip>
				))}
			</nav>
		</header>
	)
}
