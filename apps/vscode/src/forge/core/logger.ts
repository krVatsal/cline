function getVsCode(): any {
	try {
		return require("vscode");
	} catch {
		return (globalThis as any).vscode;
	}
}

class ForgeLoggerImpl {
	private channel?: any;

	private getChannel(): any {
		if (!this.channel) {
			try {
				const vs = getVsCode();
				if (typeof vs?.window?.createOutputChannel === "function") {
					this.channel = vs.window.createOutputChannel("Forge");
				}
			} catch {
				// Running in non-extension host context (e.g. tests)
			}
		}
		return this.channel;
	}

	log(message: string): void {
		const timestamp = new Date().toISOString(); // Contains millisecond timestamp: YYYY-MM-DDTHH:mm:ss.sssZ
		const line = `[${timestamp}] ${message}`;
		const ch = this.getChannel();
		if (ch) {
			ch.appendLine(line);
		}
		console.log(`[Forge] ${line}`);
	}

	show(): void {
		try {
			this.getChannel()?.show(true);
		} catch {
			// ignore
		}
	}
}

export const forgeLogger = new ForgeLoggerImpl();
