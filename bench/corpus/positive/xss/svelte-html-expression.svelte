<!-- secondpass corpus fixture — not executed. See bench/corpus/manifest.json -->
<!--
  POSITIVE: xss
  `renderedMarkdown` is server-rendered markdown from a user-authored
  wiki page, injected with {@html} instead of being escaped or passed
  through a sanitizer first.
-->
<script lang="ts">
  export let renderedMarkdown: string;
</script>

<article>
  {@html renderedMarkdown}
</article>
