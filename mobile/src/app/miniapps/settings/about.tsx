import {ScrollView, View} from "react-native"

import {Easy2SeeMark} from "@/components/brands/Easy2SeeMark"
import {Header, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {
  EASY2SEE_ATTRIBUTION,
  EASY2SEE_CREDIT_LINES,
  MENTRAOS_COPYRIGHT,
  MENTRAOS_SOURCE,
} from "@/constants/easy2seeCredits"
import {MENTRAOS_LICENSE} from "@/constants/mentraosLicense"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"

/**
 * LICENSE is hard-wrapped at 80 columns, which double-wraps on a phone. Reflow
 * each paragraph into one line; the first paragraph is the title block, so its
 * line breaks stay.
 */
const [LICENSE_TITLE, ...LICENSE_PARAGRAPHS] = MENTRAOS_LICENSE.split(/\n\s*\n/).map((paragraph) =>
  paragraph.trim().split(/\s*\n\s*/),
)

/** Easy2See's credit to MentraOS, with the full license text available offline. */
export default function AboutEasy2SeeScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()

  return (
    <Screen preset="fixed">
      <Header title="About Easy2See" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView className="pt-6 px-6 -mx-6" contentContainerStyle={{paddingBottom: theme.spacing.s10}}>
        <View className="items-center" testID="easy2see-about-header">
          <Easy2SeeMark width={132} height={45} />
          <Spacer height={theme.spacing.s4} />
          <Text
            className="text-xl font-semibold text-center"
            text={`Easy2See ${process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? ""}`.trim()}
          />
          {EASY2SEE_CREDIT_LINES.map((line) => (
            <Text key={line} className="text-sm text-center text-muted-foreground" text={line} />
          ))}
        </View>

        <Spacer height={theme.spacing.s8} />
        {EASY2SEE_ATTRIBUTION.map((paragraph) => (
          <Text key={paragraph} className="text-base text-secondary-foreground mb-4" text={paragraph} />
        ))}
        <Text className="text-sm text-muted-foreground" text={MENTRAOS_COPYRIGHT} />
        <Text className="text-sm text-muted-foreground" text={`Source: ${MENTRAOS_SOURCE}`} />

        <Spacer height={theme.spacing.s8} />
        <Text className="text-lg font-semibold mb-3" text="MentraOS license" />
        <View testID="easy2see-license">
          <Text selectable className="text-sm text-center text-muted-foreground mb-4" text={LICENSE_TITLE.join("\n")} />
          {LICENSE_PARAGRAPHS.map((lines, index) => (
            <Text key={index} selectable className="text-sm text-muted-foreground mb-3" text={lines.join(" ")} />
          ))}
        </View>
      </ScrollView>
    </Screen>
  )
}
