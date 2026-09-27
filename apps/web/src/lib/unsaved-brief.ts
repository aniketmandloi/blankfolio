const unsavedBriefEvent = "blankfolio:unsaved-change";

export function announceUnsavedBrief(dirty: boolean) {
	window.dispatchEvent(
		new CustomEvent(unsavedBriefEvent, { detail: { dirty } }),
	);
}

export function onUnsavedBriefChange(listener: (dirty: boolean) => void) {
	const handle = (event: Event) =>
		listener(Boolean((event as CustomEvent<{ dirty: boolean }>).detail?.dirty));
	window.addEventListener(unsavedBriefEvent, handle);
	return () => window.removeEventListener(unsavedBriefEvent, handle);
}

export function confirmLeavingUnsavedBrief(
	event: { preventDefault: () => void },
	dirty: boolean,
) {
	if (
		dirty &&
		!window.confirm(
			"Leave this project? Your unsaved brief edits will be lost.",
		)
	)
		event.preventDefault();
}
