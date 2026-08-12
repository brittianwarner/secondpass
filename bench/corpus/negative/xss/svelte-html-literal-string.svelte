<!-- secondpass corpus fixture — not executed. See bench/corpus/manifest.json -->
<!--
  NEGATIVE (hard): xss
  {@html} is fed a plain string literal, not an expression — nothing
  dynamic, nothing user-controlled reaches it.
-->
<article>
  {@html "<b>This article has been archived.</b>"}
</article>
