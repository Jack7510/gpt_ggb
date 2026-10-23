/** Copy only the visible message body, preserving Markdown and code blocks. */
export async function copyMessageContent(
  content: string,
  writeText: (text: string) => Promise<void>,
): Promise<void> {
  await writeText(content)
}
