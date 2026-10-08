export default {
	async fetch(): Promise<Response> {
		return new Response("hello world");
	},
} satisfies ExportedHandler;
