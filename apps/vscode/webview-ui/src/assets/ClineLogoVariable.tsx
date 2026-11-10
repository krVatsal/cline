import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"

/**
 * ZentrixLogo renders the standard enterprise geometric Zentrix emblem.
 */
const ClineLogoVariable = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment, className, ...svgProps } = props
	const accentColor = environment ? getEnvironmentColor(environment) : "var(--vscode-focusBorder, #6366F1)"

	return (
		<svg
			fill="none"
			height="64"
			role="img"
			viewBox="0 0 128 128"
			width="64"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			{...svgProps}>
			<title>Zentrix</title>
			<defs>
				<linearGradient id="zentrix_primary_grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stopColor="#38BDF8" />
					<stop offset="50%" stopColor={accentColor} />
					<stop offset="100%" stopColor="#A855F7" />
				</linearGradient>
				<linearGradient id="zentrix_beam_grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stopColor="#FFFFFF" />
					<stop offset="100%" stopColor="#94A3B8" />
				</linearGradient>
				<filter id="zentrix_glow" x="-20%" y="-20%" width="140%" height="140%">
					<feGaussianBlur stdDeviation="3" result="blur" />
					<feComposite in="SourceGraphic" in2="blur" operator="over" />
				</filter>
			</defs>

			{/* Enterprise Hexagonal Squircle Backdrop */}
			<rect
				x="6"
				y="6"
				width="116"
				height="116"
				rx="28"
				fill="#090D16"
				stroke="rgba(255, 255, 255, 0.12)"
				strokeWidth="1.5"
			/>
			<rect
				x="8"
				y="8"
				width="112"
				height="112"
				rx="26"
				fill="none"
				stroke="rgba(99, 102, 241, 0.15)"
				strokeWidth="1"
			/>

			{/* Subtly illuminated architectural grid lines */}
			<line x1="20" y1="64" x2="108" y2="64" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="3 3" />
			<line x1="64" y1="20" x2="64" y2="108" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="3 3" />

			{/* Top Horizontal Facet of Z */}
			<path
				d="M30 32 H94 C96.8 32 98.4 35.1 96.8 37.3 L79 60 H48 C44.7 60 42 57.3 42 54 L38 36 C38 33.8 35.8 32 33.6 32 Z"
				fill="url(#zentrix_primary_grad)"
				opacity="0.95"
			/>

			{/* Central Precision Energy Beam */}
			<polygon
				points="84,36 34,92 48,92 96,40 96,36"
				fill="url(#zentrix_beam_grad)"
				filter="url(#zentrix_glow)"
			/>

			{/* Bottom Horizontal Facet of Z */}
			<path
				d="M98 96 H34 C31.2 96 29.6 92.9 31.2 90.7 L49 68 H80 C83.3 68 86 70.7 86 74 L90 92 C90 94.2 92.2 96 94.4 96 Z"
				fill="url(#zentrix_primary_grad)"
				opacity="0.95"
			/>

			{/* Center Quantum Focus Point */}
			<circle cx="64" cy="64" r="5" fill="#38BDF8" filter="url(#zentrix_glow)" />
			<circle cx="64" cy="64" r="2.5" fill="#FFFFFF" />
		</svg>
	)
}

export default ClineLogoVariable
