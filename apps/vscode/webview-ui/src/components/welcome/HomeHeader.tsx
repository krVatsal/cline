import { EmptyRequest } from "@shared/proto/cline/common"
import ClineLogoVariable from "@/assets/ClineLogoVariable"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

interface HomeHeaderProps {
	shouldShowQuickWins?: boolean
}

const HomeHeader = ({ shouldShowQuickWins = false }: HomeHeaderProps) => {
	const { environment } = useExtensionState()

	const handleTakeATour = async () => {
		try {
			await UiServiceClient.openWalkthrough(EmptyRequest.create())
		} catch (error) {
			console.error("Error opening walkthrough:", error)
		}
	}

	return (
		<div className="flex flex-col items-center pt-8 pb-6 px-4 select-none">
			{/* Emblem with ambient glow */}
			<div className="relative mb-5 flex items-center justify-center">
				<div className="absolute -inset-3 bg-gradient-to-r from-sky-500/20 via-indigo-500/20 to-purple-500/20 blur-xl rounded-full opacity-60 pointer-events-none" />
				<div className="relative transform transition-transform hover:scale-105 duration-300">
					<ClineLogoVariable className="size-20 drop-shadow-md" environment={environment} />
				</div>
			</div>

			{/* Brand Heading */}
			<div className="text-center flex flex-col items-center justify-center">
				<div className="flex items-center gap-2">
					<h1 className="m-0 text-xl font-bold tracking-tight text-text-primary">
						Zentrix
					</h1>
					<span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase bg-white/[0.06] text-text-secondary border border-white/[0.08]">
						v4.2
					</span>
				</div>
				<p className="mt-1.5 mb-0 text-xs text-text-secondary font-medium tracking-wide">
					Autonomous Software Engineering Agent
				</p>
			</div>

			{/* Enterprise Status Chip */}
			<div className="mt-3.5 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.03] border border-white/[0.08] text-xs shadow-xs">
				<span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
				<span className="text-[11px] font-medium text-text-primary">TrueForge</span>
				<span className="text-white/20">·</span>
				<span className="text-[11px] text-text-secondary">Ready</span>
			</div>

			{shouldShowQuickWins && (
				<div className="mt-5">
					<button
						className="flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/[0.1] bg-white/[0.04] hover:bg-white/[0.08] transition-all duration-150 text-text-primary text-xs font-medium cursor-pointer shadow-xs"
						onClick={handleTakeATour}
						type="button">
						<span>Take a Tour</span>
						<span className="codicon codicon-play scale-75 opacity-70" />
					</button>
				</div>
			)}
		</div>
	)
}

export default HomeHeader
